# SAC Script Patterns

All methods used here exist in the OSE reference (2026.15). Widget names (`tbl_Sales`, `chr_Revenue`, …) and dimension/member IDs are placeholders — replace them with the real outline names and technical IDs of the story/model. Check the class file for restrictions before adapting a pattern.

## Filtering

```javascript
// Batch several filter changes into one backend roundtrip
var ds = tbl_Sales.getDataSource();
ds.setRefreshPaused(true);
ds.setDimensionFilter("Region", ["EMEA", "APJ"]);              // include list
ds.setDimensionFilter("Product", {value: "P100", exclude: true}); // SingleFilterValue
ds.removeDimensionFilter("Channel");
ds.setRefreshPaused(false);
```

```javascript
// Propagate the filter of one data source to others
chr_Revenue.getDataSource().copyDimensionFilterFrom(tbl_Sales.getDataSource(), "Region");
```

```javascript
// Read the current filter of a dimension
var filters = tbl_Sales.getDataSource().getDimensionFilters("Region");
for (var i = 0; i < filters.length; i++) {
    if (filters[i].type === FilterValueType.Single) {
        var single = cast(Type.SingleFilterValue, filters[i]);
        console.log(single.value);
    } else if (filters[i].type === FilterValueType.Multiple) {
        var multi = cast(Type.MultipleFilterValue, filters[i]);
        console.log(multi.values);
    }
}
```

Hierarchical dimension: members must belong to the active hierarchy. Once a dimension has a hierarchy it is the default view and leaf filters return "No data" → switch to the flat view first:

```javascript
ds.setHierarchy("Product", Alias.FlatHierarchy);
ds.setDimensionFilter("Product", ["P1", "P2", "P3", "P4"]);
```

`setDimensionFilter` replaces the widget's filter on that dimension; filters on other dimensions, story/page filters and input controls stay in effect. Script filters are not visible in the builder.

## Chart / table selection → filter other widgets

```javascript
// chr_Revenue.onSelect
var sel = chr_Revenue.getSelections();
var ds = tbl_Detail.getDataSource();
if (sel.length > 0) {
    ds.setDimensionFilter("Region", sel[0]["Region"]);
} else {
    ds.removeDimensionFilter("Region");
}
```

## Input controls

```javascript
// ic_Year.onSelect
var members = ic_Year.getInputControlDataSource().getActiveSelectedMembers();
var ids = ArrayUtils.create(Type.string);
for (var i = 0; i < members.length; i++) {
    ids.push(members[i].id);
}
tbl_Sales.getDataSource().setDimensionFilter("Date", ids);
```

## Reading values

```javascript
// One cell: build a Selection with the measure under Alias.MeasureDimension
var sel = {"Region": "EMEA"};
sel[Alias.MeasureDimension] = "Revenue";
var cell = tbl_Sales.getDataSource().getData(sel);
txt_KPI.applyText(cell.formattedValue);
```

```javascript
// Many cells: iterate a result set (each entry: dimension -> {id, description, formattedValue, rawValue})
var rs = chr_Revenue.getDataSource().getResultSet();
for (var i = 0; i < rs.length; i++) {
    var region = rs[i]["Region"].description;
    var value = rs[i][Alias.MeasureDimension].rawValue;
    console.log(region + ": " + value);
}
```

Read real dimension IDs with `getDimensions()` / `getMeasures()` or `console.log(rs)` first — IDs in BW/HANA models are often generated (`Location_4nm2e04531`).

## Dropdown filled from members (cache in a global variable)

```javascript
// SO_FILTER.fillRegionDropdown()  – call once from onInitialization
var members = tbl_Sales.getDataSource().getMembers("Region");
dd_Region.removeAllItems();
for (var i = 0; i < members.length; i++) {
    dd_Region.addItem(members[i].id, members[i].description);
}

// dd_Region.onSelect
tbl_Sales.getDataSource().setDimensionFilter("Region", dd_Region.getSelectedKey());
```

## Model variables (prompts)

```javascript
var ds = tbl_Sales.getDataSource();
ds.setVariableValue("V_YEAR", "2026");
var others = [chr_Revenue.getDataSource()];
for (var i = 0; i < others.length; i++) {
    others[i].copyVariableValueFrom(ds, "V_YEAR");
}
```

## Show/hide widgets (toggle view)

```javascript
// SO_LAYOUT.showTable(showTable: boolean)
tbl_Sales.setVisible(showTable);
chr_Revenue.setVisible(!showTable);
```

## Planning: enter value, publish

```javascript
var planning = tbl_Plan.getPlanning();
// Version/date member IDs are model-specific – read them via getSelections()/getResultSet() first
var sel = {"Version": "public.Forecast", "Date": "202612", "Region": "EMEA"};
sel[Alias.MeasureDimension] = "Revenue";
if (planning.setUserInput(sel, "1000")) {
    planning.submitData();          // submit immediately, otherwise input may be discarded
}

var forecast = planning.getPublicVersion("Forecast");
if (forecast && forecast.isDirty()) {
    forecast.publish();
}
```

Before scripting versions, check `Planning.md`, `PlanningPublicVersion.md`, `PlanningPrivateVersion.md` (OSE also offers model-level `PlanningModel*Version`).

## Data action / multi action

```javascript
// blocking
Application.showBusyIndicator();
da_Allocate.setParameterValue("TargetVersion", "public.Forecast");
var resp = da_Allocate.execute();
Application.hideBusyIndicator();
if (resp.status === DataActionExecutionResponseStatus.Success) {
    Application.showMessage(ApplicationMessageType.Success, "Allocation finished");
} else {
    Application.showMessage(ApplicationMessageType.Error, "Allocation failed");
}
```

```javascript
// non-blocking: start, then react in da_Allocate.onExecutionStatusUpdate(status, executionId, executionName)
da_Allocate.executeInBackground("Allocation " + Application.getUserInfo().id);
```

Multi actions have the same shape (`MultiAction.execute / executeInBackground / setParameterValue`).

## Popups

```javascript
pop_Settings.open();

// pop_Settings.onButtonClick(buttonId)
if (buttonId === "btn_ok") {
    SO_FILTER.apply();
}
pop_Settings.close();
```

## Navigation and URL parameters

```javascript
NavigationUtils.openStory("STORY_ID", "PAGE_ID",
    [UrlParameter.create("p_gv_selectedYear", "2026")], true);
```

Global script variables flagged *Expose variable via URL parameter* are set by `p_<variableName>` in the URL — use them in `onInitialization`.

## Delayed / repeated execution

```javascript
// No setTimeout: use a Timer widget
tmr_Refresh.start(30);               // seconds

// tmr_Refresh.onTimeout
Application.refreshData([tbl_Sales.getDataSource()]);
tmr_Refresh.start(30);
```

## Iterating widgets dynamically

`WidgetType` values are not listed in the API reference (empty enum) — confirm the member name with the script editor's autocomplete. `getWidgets` only searches the first page (OSE note in `Application.md`); the return type follows `type`, so `cast` is only needed for generic results.

```javascript
var tables = Application.getWidgets({type: WidgetType.Table, searchPattern: "tbl_"});
for (var i = 0; i < tables.length; i++) {
    var t = cast(Type.Table, tables[i]);
    t.getDataSource().setDimensionFilter("Region", "EMEA");
}
```

## Styling at runtime

```javascript
// BT_CSS_TEST.onClick – toggle a CSS class defined in the story CSS (see sac-css skill)
if (PA_CARD_FILTERBAR.getCssClass() === "card-accent") {
    PA_CARD_FILTERBAR.setCssClass("card");
} else {
    PA_CARD_FILTERBAR.setCssClass("card-accent");
}
```

A widget CSS class replaces the global default class for that widget — the class you switch to must contain all rules the widget needs.

## Dashboard patterns

Shortened from a working dashboard (script object `SO_DASH`).

### Hierarchy level per chart

```javascript
// Donut: categories only; treemap: category → product
CH_DON_CATEGORY_001.getDataSource().setHierarchy("Product", "H_CAT");
CH_DON_CATEGORY_001.getDataSource().setHierarchyLevel("Product", 1);   // 1 = nodes
CH_TREE_PRODUCT_001.getDataSource().setHierarchy("Product", "H_CAT");
CH_TREE_PRODUCT_001.getDataSource().setHierarchyLevel("Product", 2);   // 2 = leaves
```

### State + re-apply: segment switch

Two buttons, the active one styled by CSS class, charts swapped with `setVisible`. The state lives in a global variable so other functions (e.g. store selection) can re-apply it. No `?:` — SAC rejects the conditional operator.

```javascript
// SO_DASH.showPeriod(p: string) – BT_PER_KW.onClick: SO_DASH.showPeriod("KW")
gv_period = p;
var isKw = p !== "MONAT";
CH_COL_KW_001.setVisible(isKw);
CH_COL_MONAT_001.setVisible(!isKw);
if (isKw) {
    BT_PER_KW.setCssClass("seg-active");
    BT_PER_MON.setCssClass("seg");
} else {
    BT_PER_KW.setCssClass("seg");
    BT_PER_MON.setCssClass("seg-active");
}
```

```javascript
// SO_DASH.select(f: string) – after changing the filter, re-apply the other state
gv_store = f;
// … set/remove the store filter on all data sources …
SO_DASH.showPeriod(gv_period);
```

### Clickable tile

Panels have no `onClick`, and story CSS has no `:hover` on panels. Put a transparent button over the panel; its `onClick` calls `SO_DASH.select("S1")`, which marks the active tile with `setCssClass("tile-active")`. Remove the browser focus outline of the button in the **theme** CSS (`outline: none` is not allowed in story CSS — see sac-css).

### Progress bar from panels

```javascript
// fill = inner panel of a track panel; p = percent of target
var w = p;
if (w > 100) {
    w = 100;
}
fill.getLayout().setWidth(LayoutValue.create(w, LayoutUnit.Percent));
if (p > 95) {
    fill.setCssClass("fill-done");      // green
} else if (p >= 75) {
    fill.setCssClass("fill");           // orange
} else {
    fill.setCssClass("fill-low");       // red
}
```

### KPI values from a hidden helper chart

A small invisible chart (store × version, today) delivers the numbers; its `onResultChanged` updates the tiles.

```javascript
// CH_HELPER_TODAY.onResultChanged: SO_DASH.updateTiles();
var rs = CH_HELPER_TODAY.getDataSource().getResultSet();
for (var i = 0; i < rs.length; i++) {
    var store = rs[i]["Store"].id;                   // e.g. "[Store].[…].&[S1]" – compare with indexOf
    var isPlan = rs[i]["Version"].id.indexOf("Plan") >= 0;   // "public.Plan"
    var n = ConvertUtils.stringToNumber(rs[i][Alias.MeasureDimension].rawValue);
    // … sum per store and version …
}
```

### Fixed reference date and periods

```javascript
var today = new Date(2026, 9, 29);          // month is 0-based: 9 = October
var monthStart = new Date(2026, 9, 1);
var day = TimeRange.create(TimeRangeGranularity.Day, today, today);
var mtd = TimeRange.create(TimeRangeGranularity.Day, monthStart, today);
CH_HELPER_TODAY.getDataSource().setDimensionFilter("Date", day);
CH_BAR_ABW_001.getDataSource().setDimensionFilter("Date", mtd);
```

Also available: `TimeRange.createMonthRange`, `createWeekRange`, `createYearRange`.

### Responsive header

```javascript
// SO_DASH.layoutHeader() – call from PAGE_1.onInitialization AND PAGE_1.onResize
var w = Application.getInnerWidth().value;   // width of the first page / viewport
var h = 40;
if (w <= 760) {
    h = 58;                                   // flow panel wraps into two rows
}
PA_HEADER.getLayout().setHeight(h);
FP_BODY.getLayout().setTop(h + 5);
```

### Top N in a mini chart

```javascript
var m = CH_MINI_GES.getMembers(Feed.ValueAxis);
if (m.length > 0) {
    CH_MINI_GES.rankBy({structureMember: m[0], rankOrder: RankOrder.Top, value: 4});
}
```

Only in optimized view mode, not on charts with structures; same for `sortByValue` / `sortByMember`.

### Number and date formatting

```javascript
NumberFormat.format(1359.5);                          // user settings → "1,359.5" (English profile)
var nf = NumberFormat.create();
nf.setGroupingSeparator(",");
nf.setDecimalSeparator(".");
nf.setMaximumDecimalPlaces(0);
nf.format(1234567.89);                                // → "1,234,568"
var d = new Date(2026, 9, 29);
DateFormat.format(d, "EEEE, MMMM d, yyyy");           // → "Thursday, October 29, 2026" (profile language)
DateFormat.format(d, "EEE dd.MM.yyyy");               // → "Thu 29.10.2026"
```

Replaces hand-written thousands separators and weekday/month name arrays. Only the English profile was tested; with a German profile the names should follow the profile language (LDML) — check once.
