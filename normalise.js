// Turns a battery or solar module datasheet's text into one value per canonical field, in canonical units.
// Pure: no DOM. app.js and the Node tests both import it.
//
// Most datasheet PDFs store a spec table as all the labels, then all the values, so pdf.js's text order
// pairs nothing. pageText() regroups the text items into visual lines first, which brings a row back to
// "Label value unit". Each field is then found by its label synonyms, the user's taught ones first (see
// withSynonyms()), then the built-in ones most specific first: the first label that matches anywhere wins, then
// its first match in reading order. A number only counts if it carries a unit the field accepts, written next
// to the number or in the label ("Nominal Capacity(Wh) 4800", "Usable capacity kWh 5.0").
//
// A solar module sheet describes several power classes in one table, one column each ("Maximum Power (Pmax)
// 600 605 610 …"); normalise() turns those columns into variants.

const H = '[^\\S\\n]*'; // spaces, never a line break: a value has to be on its label's line
const NUM = '[-+]?\\d+(?:[.,]\\d+)*(?![.,]?\\d)'; // whole numbers only: never "8" out of "80"
// Allowed between a label and its number: a footnote digit, stuck to the label ("efficiency3 %") or followed
// by another number ("Cycle Life 1 3000 cycles", but "Max current 2 A 50 A" is 2), separators, commas,
// comparators, footnote stars and #, symbols ("Module Efficiency η(%)", "of Current (Isc), α (%/°C)"), (asides),
// [refs] and up to 6 whole words ("Weight of battery unit"), but not "and" or "or" right before the number: in
// "1st year degradation and 0.55%" it is another figure's ("Number of cells and cell type 144" is fine).
const GAP = `(?:\\d(?=\\s)|${H}\\d(?=[^\\S\\n]+\\d))?(?:${H}(?:[:|=≥≤><≈~/%°*#,αβγηß-]|\\([^)\\n]*\\)|\\[[^\\]\\n]*\\]|(?!(?:and|or)${H}[-+]?[\\d.])[a-z][\\w.&/-]*(?![\\w.&/-]))){0,6}?${H}`;
const FREE = '(?<!\\w)'; // a number stuck to a word is a footnote mark ("cycles5"), not a value
const SIDE = '(?:[WDHLT]|width|depth|height|length|thickness)';
const ORDER = `${SIDE}\\s?[xX×*/]\\s?${SIDE}\\s?[xX×*/]\\s?${SIDE}`; // "W x D x H", "(H/W/D)", "[W*D*H]", "L×W×T", "Length × Width × Height"
const NOT_USABLE = '(?<!(?:use?able|available)(?: \\w+)? )'; // "Nominal energy" must not take "Usable (energy) capacity"

// Unit spellings (lower case, no spaces or °) -> [canonical unit, factor]. Ah stays Ah: kWh would need the voltage.
const UNITS = {
  wh: ['kWh', 1e-3], kwh: ['kWh', 1], mwh: ['kWh', 1e3], mah: ['Ah', 1e-3], ah: ['Ah', 1],
  w: ['kW', 1e-3], kw: ['kW', 1], mw: ['kW', 1e3],
  v: ['V', 1], vdc: ['V', 1], vcc: ['V', 1], kv: ['V', 1e3], a: ['A', 1], '%': ['%', 1], '%/year': ['%', 1], '%/yr': ['%', 1],
  c: ['°C', 1], '%/c': ['%/°C', 1], '%/k': ['%/°C', 1], '%/': ['%/°C', 1], // "-0.30%/": the °C glyph lost
  cycle: ['cycles', 1], cycles: ['cycles', 1], times: ['cycles', 1], year: ['years', 1], years: ['years', 1], yr: ['years', 1], yrs: ['years', 1],
  kg: ['kg', 1], kgs: ['kg', 1], g: ['kg', 1e-3], t: ['kg', 1e3], lb: ['kg', 0.45359237], lbs: ['kg', 0.45359237],
  mm: ['mm', 1], cm: ['mm', 10], m: ['mm', 1e3], in: ['mm', 25.4], inch: ['mm', 25.4], inches: ['mm', 25.4], '"': ['mm', 25.4],
};
const ENERGY = ['MWh|kWh|Wh', 'mAh|Ah']; // an Ah figure only when the sheet gives no Wh one

// Table rows, in order. labels: case-insensitive regex sources, most specific first (a generic "capacity" or
// "power" last); a space matches any whitespace. To add a synonym, add a string to that field's labels.
export const FIELDS = [
  { name: 'Product name', unit: '', find: productName },
  { name: 'Manufacturer', unit: '', find: manufacturer },
  { name: 'Chemistry', unit: '', find: chemistry },
  { name: 'Nominal energy', unit: 'kWh', find: number, units: ENERGY, labels: ['(?:nominal|rated|total|battery)(?: (?!use?able|available)\\w+){0,2} (?:energy|capacity)', `${NOT_USABLE}energy capacity`, `${NOT_USABLE}capacity`] },
  { name: 'Usable energy', unit: 'kWh', find: number, units: ENERGY, labels: ['(?:use?able|available)(?: \\w+)? (?:energy|capacity)', '(?:energy|capacity) \\((?:use?able|available)\\)'] },
  { name: 'Nominal voltage', unit: 'V', find: number, units: ['V ?dc|Vcc|kV|V'], labels: ['(?<!cell[^\\S\\n])(?:nominal|rated)(?: dc| battery)? voltage(?! (?:of |per )?cell)'] },
  { name: 'Voltage range', unit: 'V', find: range, units: ['V ?dc|V'], labels: ['(?:operating|working) voltage(?: range| window)?', 'battery voltage range', 'discharge voltage', '(?<!input |mppt |pv )voltage range'] },
  { name: 'Max continuous charge power', unit: 'kW', find: number, units: ['MW|kW|W'], labels: ['(?:max(?:imum)?\\.? )?(?:continuous |rated |nominal )?charg(?:e|ing)(?:/discharg(?:e|ing))? power'] },
  { name: 'Max continuous discharge power', unit: 'kW', find: number, units: ['MW|kW|W'], labels: ['(?:max(?:imum)?\\.? )?(?:continuous |rated |nominal )?(?:charg(?:e|ing)/)?discharg(?:e|ing) power', 'max(?:imum)?\\.? (?:continuous )?output power', '(?:rated|nominal|continuous)(?: output)? power'] },
  { name: 'Max continuous current', unit: 'A', find: number, units: ['A'], labels: ['(?:max(?:imum)?\\.?|continuous|rated\\.?)(?: [\\w/.]+){0,3}? current(?! per)'] },
  { name: 'Round-trip efficiency', unit: '%', find: number, units: ['%'], labels: ['round[\\s-]?trip(?: efficiency)?', 'RTE', '(?:AC|DC)/(?:AC|DC) efficiency'] },
  { name: 'Depth of discharge', unit: '%', find: number, units: ['%'], labels: ['depth of discharge', 'DoD'] },
  { name: 'Cycle life', unit: 'cycles', find: number, units: ['cycles?|times'], unitless: true, bare: `(${NUM})${H}cycles`, labels: ['cycle life', 'cycle count', 'life cycles?', 'cycles'] },
  // A battery's discharge range first, wherever its row puts it: "Working Temperature Discharge -10~55℃",
  // "Operating Temperature (°C) Charge: 0<T<50°C / Discharge: -10<T<50°C", "(discharging) °C -20 to 55". Last, a
  // bare "Temperature Range", never "Storage …" or "Optimum …".
  { name: 'Operating temperature', unit: '°C', find: range, units: ['°?[CF]'], labels: ['temp(?:erature|\\.)?[^\\n]*?discharg(?:e|ing)\\)?', '(?<!optimum )(?:operating|working|ambient|operation(?:al)?)(?: \\w+)? temp(?:erature|\\.)?(?: range)?', 'discharg(?:e|ing) temp(?:erature|\\.)?(?: range)?', '(?<![a-z][^\\S\\n]{1,3})temp(?:erature|\\.)? range'] },
  { name: 'Weight', unit: 'kg', find: number, units: ['kgs?|lbs?|g|t'], labels: ['weight', 'mass'] },
  { name: 'Dimensions W×D×H', unit: 'mm', find: dimensions, units: ['mm|cm|m|inch(?:es)?|in|"'], labels: ['dimensions?', ORDER, 'size'] },
  { name: 'IP rating', unit: '', find: ipRating, labels: ['ip rating', 'ingress (?:protection|rating)', 'protection (?:class|rating|level|degree)', 'degree of protection', 'enclosure(?: rating)?'] },
  { name: 'Design life or warranty', unit: 'years', find: number, units: ['years?|yrs?'], bare: `(${NUM})${H}-?${H}y(?:ea)?rs?${H}(?:limited${H})?(?:product${H})?warranty`, labels: ['warranty', 'design life', 'service life', 'calendar life', 'expected life'] },
  { name: 'Certifications', unit: '', find: certifications },
];

const CERTS = [
  ['UL 9540', /UL ?9540(?![A\d])/], ['UL 9540A', /UL ?9540A/], ['UL 1973', /UL ?1973/], ['IEC 62619', /IEC ?62619/],
  ['IEC 62040', /(?:IEC|EN) ?62040/], ['UN 38.3', /UN ?38\.3/], ['CE', /\bCE\b/], ['UKCA', /\bUKCA\b/],
];
// Counted, not first-found: a sheet names its maker many times, compatible inverter brands once.
const BRANDS = ['Pylontech', 'BYD', 'Huawei', 'Sungrow', 'CATL', 'Tesla', 'Dyness', 'Deye', 'Alpha ESS', 'Enphase', 'LG Energy Solution',
  'sonnen', 'SolarEdge', 'GoodWe', 'Growatt', 'Fox ESS', 'Hithium', 'EVE Energy', 'Trina', 'Fluence', 'Sigenergy', 'Victron', 'Exide',
  'Amara Raja', 'Livguard'];

const SOLAR_CERTS = [
  ['IEC 61215', /(?:IEC|EN) ?61215/], ['IEC 61730', /(?:IEC|EN) ?61730/], ['IEC 61701', /(?:IEC|EN) ?61701/], ['IEC 62716', /(?:IEC|EN) ?62716/],
  ['UL 61730', /UL ?61730/], ['ALMM', /\bALMM\b/], ['BIS', /\bBIS\b|\bIS ?14286/], ['CE', /\bCE\b/],
];
const SOLAR_BRANDS = ['INOX Solar', 'Waaree', 'Adani', 'Tata Power', 'Vikram Solar', 'Premier Energies', 'Goldi', 'RenewSys', 'Rayzon',
  'Saatvik', 'Emmvee', 'Polycab', 'Jakson', 'Navitas', 'Gautam Solar', 'Websol', 'LONGi', 'Jinko', 'JA Solar', 'Trina', 'Canadian Solar',
  'Risen', 'Astronergy', 'Tongwei', 'Aiko'];

// The module's maximum power, never "Maximum power voltage", "Voltage at maximum power", "Voltage at Pmax", "V@Pmax"
// or "Pmax tolerance".
const PMAX = [
  '(?<!(?:voltage|current) at )(?:max(?:imum|\\.)?|rated|nominal|peak)(?: max(?:imum|\\.)?)? power(?: output)?(?! (?:voltage|current|point|tolerance|temp|warranty))',
  '(?<!(?:tolerance|coefficient)[^\\w\\n]*(?:of )?|(?:voltage|current) at |[VI]@)P\\s?max(?! (?:tolerance|temp))',
];
// "Temperature coefficient of Pmax", "Pmax temperature coefficient", "Temp. coeff. (Pmax)", "Tc of Power (γ)", and
// "coef cient" or "coe cient", as PDFs with a broken fi or ffi ligature print it.
const COE = 'coe(?:ff?i|f? )cients?|coeff?\\.?';
const coefficient = (of) => [`(?:temp(?:erature|\\.)? (?:${COE})|T\\s?c)(?: of)?[^\\w\\n]{0,3}(?:${of})\\)?`, `(?:${of}) temp(?:erature|\\.)? (?:${COE})`];
const PERCENT_PER_C = `%${H}/${H}(?:°?[CK])?`; // "%/°C", "% / °C", "%/K", or "%/" with the °C glyph lost
const shared = (name) => FIELDS.find((f) => f.name === name);

// Rows with one number per power class use find: series; normalise() splits them into variants.
export const SOLAR_FIELDS = [
  shared('Product name'),
  { ...shared('Manufacturer'), brands: SOLAR_BRANDS },
  { name: 'Cell technology', unit: '', find: cellTech },
  { name: 'Cell count', unit: 'cells', find: number, units: ['cells?|pcs'], unitless: true, bare: `${FREE}(${NUM})${H}(?:half[\\s-]?(?:cut${H})?)?cells`, labels: ['(?:no\\.?|number) of cells', 'cells? (?:count|quantity|qty|arrangement|orientation)'] },
  { name: 'Max power Pmax', unit: 'W', find: series, units: ['Wp?'], labels: PMAX },
  { name: 'Module efficiency', unit: '%', find: series, units: ['%'], labels: ['module efficienc[ye]', '(?:conversion|panel) efficiency', '(?<!cell )efficiency'] },
  { name: 'Vmp', unit: 'V', find: series, units: ['V'], labels: ['(?:max(?:imum|\\.)?|rated|nominal) power(?: point)? voltage', 'voltage at (?:max(?:imum|\\.)?|rated|nominal) power(?: point)?', 'opt(?:imum|\\.)? operating voltage', 'MPP voltage', 'V\\s?mpp?'] },
  { name: 'Imp', unit: 'A', find: series, units: ['A'], labels: ['(?:max(?:imum|\\.)?|rated|nominal) power(?: point)? current', 'current at (?:max(?:imum|\\.)?|rated|nominal) power(?: point)?', 'opt(?:imum|\\.)? operating current', 'MPP current', 'I\\s?mpp?'] },
  { name: 'Voc', unit: 'V', find: series, units: ['V'], labels: ['open[\\s-]circuit voltage', 'V\\s?oc'] },
  { name: 'Isc', unit: 'A', find: series, units: ['A'], labels: ['short[\\s-]circuit current', 'I\\s?sc'] },
  { name: 'Power tolerance', unit: '%', find: tolerance, labels: ['power(?: output)? tolerance', 'P\\s?max tolerance', '(?<!measure(?:ment|d)? |measuring )tolerance'] },
  { name: 'Temperature coefficient of Pmax', unit: '%/°C', find: number, units: [PERCENT_PER_C], labels: coefficient('P\\s?m(?:ax|pp)?|(?:max(?:imum)? |rated |peak )?power(?! (?:voltage|current|point))') },
  { name: 'Temperature coefficient of Voc', unit: '%/°C', find: number, units: [PERCENT_PER_C], labels: coefficient('V\\s?oc|open[\\s-]circuit voltage|voltage') },
  { name: 'Temperature coefficient of Isc', unit: '%/°C', find: number, units: [PERCENT_PER_C], labels: coefficient('I\\s?sc|short[\\s-]cirr?cuit current|current') },
  { name: 'NMOT or NOCT', unit: '°C', find: number, units: ['°?C'], labels: ['nominal (?:module )?operating (?:cell )?temp(?:erature|\\.)?', 'N(?:MOT|OCT)'] },
  { name: 'Max power at NMOT/NOCT', unit: 'W', find: series, units: ['Wp?'], labels: PMAX, at: 'NMOT' },
  { name: 'Max system voltage', unit: 'V', find: number, units: ['V ?dc|V'], labels: ['max(?:imum|\\.)? system voltage', 'system voltage'] },
  { name: 'Max series fuse', unit: 'A', find: number, units: ['A'], labels: ['max(?:imum|\\.)? series fuse(?: rating)?', 'series fuse(?: rating)?', 'fuse rating', 'max(?:imum|\\.)? reverse current'] },
  shared('Operating temperature'),
  { ...shared('Dimensions W×D×H'), name: 'Dimensions L×W×H' },
  shared('Weight'),
  // The front glass first: "Front Cover(Glass) 2.0 mm", "Superstrate 3.2 mm", before a "Glass … Cable 4 mm²" further down.
  { name: 'Glass', unit: '', find: glass, units: ['mm'], bare: `(${NUM})${H}mm${H}(?:[\\w-]+${H}){0,3}glass`, labels: ['front (?:side )?(?:glass|cover)(?: thickness)?', 'superstrate', '(?:rear |back )?(?:side )?glass(?: thickness)?'] },
  { name: 'Frame', unit: '', find: frame },
  { name: 'Connector', unit: '', find: connector },
  // Also after the number: "12-Year Material Warranty", "12 Enhanced Product Warranty", "30 performancewarranty".
  { name: 'Product warranty', unit: 'years', find: number, units: ['years?|yrs?'], bare: `(${NUM})${H}-?${H}(?:y(?:ea)?rs?${H}(?:limited${H})?(?:product|materials?|workmanship)|(?:(?:limited|enhanced)${H})?(?:product|materials?|workmanship)${H}warranty)`, labels: ['(?:product|materials?(?: and workmanship)?|workmanship)(?: \\w+)? warranty'] },
  { name: 'Power warranty', unit: 'years', find: number, units: ['years?|yrs?'], bare: `(${NUM})${H}-?${H}(?:y(?:ea)?rs?${H}(?:linear${H})?(?:power|performance|output)|(?:(?:linear|limited)${H})?(?:power|performance|output)(?:${H}(?:power|performance|output))?${H}warranty)`, labels: ['(?:linear |limited )?(?:power|performance|output)(?: output)? warranty'] },
  { name: 'First-year degradation', unit: '%', find: number, units: ['%'], bare: `(${NUM})${H}%(?:${H}(?:for|in|the|power|degradation|attenuation))*${H}(?:1st|first)[\\s-]year`, labels: ['(?:1st|first)[\\s-]year(?: power)? (?:degradation|attenuation)', '(?:degradation|attenuation) (?:in )?(?:the )?(?:1st|first) year'] },
  { name: 'Annual degradation', unit: '%', find: number, units: ['%(?:/y(?:ea)?r)?'], bare: `(${NUM})${H}%${H}(?:annual|yearly|per year)`, labels: ['(?:annual|yearly)(?: power)? (?:degradation|attenuation)', '(?:linear|subsequent)(?: power)? degradation', 'degradation (?:per year|annually)'] },
  { name: 'Bifaciality', unit: '%', find: number, units: ['%'], labels: ['bifaciality(?: factor| coefficient| ratio)?', 'bifacial (?:factor|coefficient|ratio)'] },
  { ...shared('Certifications'), certs: SOLAR_CERTS },
];

export const FIELD_SETS = { battery: FIELDS, solar: SOLAR_FIELDS };

// The comparison table, shared by app.js and gen-compare.mjs: its row groups, in order, each keeping its fields in
// field-set order. A field not named here still shows, under "Other", so a field added above can't go missing from
// the table or the copy.
const GROUPS = {
  battery: {
    Identity: ['Product name', 'Manufacturer', 'Chemistry'],
    'Energy & power': ['Nominal energy', 'Usable energy', 'Max continuous charge power', 'Max continuous discharge power'],
    Electrical: ['Nominal voltage', 'Voltage range', 'Max continuous current'],
    Performance: ['Round-trip efficiency', 'Depth of discharge', 'Cycle life', 'Operating temperature'],
    Mechanical: ['Weight', 'Dimensions W×D×H', 'IP rating'],
    'Warranty & certification': ['Design life or warranty', 'Certifications'],
  },
  solar: {
    Identity: ['Product name', 'Manufacturer', 'Cell technology', 'Cell count'],
    'Electrical (STC)': ['Max power Pmax', 'Module efficiency', 'Vmp', 'Imp', 'Voc', 'Isc', 'Power tolerance', 'Max system voltage', 'Max series fuse', 'Bifaciality'],
    Temperature: ['Temperature coefficient of Pmax', 'Temperature coefficient of Voc', 'Temperature coefficient of Isc', 'NMOT or NOCT', 'Max power at NMOT/NOCT', 'Operating temperature'],
    Mechanical: ['Dimensions L×W×H', 'Weight', 'Glass', 'Frame', 'Connector'],
    'Warranty & degradation': ['Product warranty', 'Power warranty', 'First-year degradation', 'Annual degradation'],
    Certification: ['Certifications'],
  },
};

/** The table's row groups for a type ('battery' or 'solar'): [title, fields] pairs, in order. */
export function sections(type) {
  const fields = FIELD_SETS[type];
  const groups = Object.entries(GROUPS[type]).map(([title, names]) => [title, fields.filter((f) => names.includes(f.name))]);
  const rest = fields.filter((f) => !groups.some(([, group]) => group.includes(f)));
  return rest.length ? [...groups, ['Other', rest]] : groups;
}

// Best value per row, scored so that higher wins: more energy, efficiency, power, cycles, warranty; less weight and
// degradation; a temperature coefficient nearest zero.
const more = (n) => n;
const less = (n) => -n;
const nearZero = (n) => -Math.abs(n);
const BEST = {
  'Nominal energy': more, 'Usable energy': more, 'Round-trip efficiency': more, 'Depth of discharge': more, 'Cycle life': more,
  'Design life or warranty': more, 'Max power Pmax': more, 'Module efficiency': more, 'Max power at NMOT/NOCT': more,
  Bifaciality: more, 'Product warranty': more, 'Power warranty': more,
  Weight: less, 'First-year degradation': less, 'Annual degradation': less,
  'Temperature coefficient of Pmax': nearZero, 'Temperature coefficient of Voc': nearZero,
};

/**
 * Which of a row's values (one per column, as normalise() gives them) hold its best, as booleans; [] for none. Numbers
 * in the row's own unit only (never Ah against kWh), at least two of them, and not all equal (a dot on every cell
 * says nothing). Ties all win.
 */
export function bestOf(f, values) {
  const score = BEST[f.name];
  if (!score) return [];
  const s = values.map((v) => (typeof v?.value === 'number' && v.unit === f.unit ? score(v.value) : NaN));
  const known = s.filter((x) => !Number.isNaN(x));
  const top = Math.max(...known);
  return known.length > 1 && known.some((x) => x !== top) ? s.map((x) => x === top) : [];
}

// Counted: a module sheet names Pmax, Voc and Isc in every table row, a battery sheet its kWh and cycles. A
// battery with solar inputs (Powerwall 3) names Isc and Imp per MPPT too, so batteries, discharge and MPPTs count.
const SOLAR_MARKS = /\bP\s?max\b|\bV\s?oc\b|\bI\s?sc\b|\bV\s?mpp?\b|\bI\s?mpp?\b|open[\s-]circuit|short[\s-]circuit current|module efficiency|\bN(?:OCT|MOT)\b|bi-?facial|half[\s-]cut|series fuse/gi;
const BATTERY_MARKS = /\b[kM]?Wh\b|\bm?Ah\b|cycle life|depth of discharge|\bDoD\b|LiFePO|\bLFP\b|usable (?:energy|capacity)|round[\s-]?trip|\bBMS\b|\bbatter(?:y|ies)\b|discharg|\bMPPTs?\b/gi;

/** 'solar' when module markers (Pmax, Voc, Isc, module efficiency, NOCT…) outnumber battery ones (kWh, cycle life, DoD, battery, MPPT…), else 'battery'. */
export function detectType(text) {
  const count = (re) => String(text ?? '').match(re)?.length ?? 0;
  return count(SOLAR_MARKS) > count(BATTERY_MARKS) ? 'solar' : 'battery';
}

/**
 * FIELD_SETS with the user's own labels, `{ 'Nominal energy': ['Rated Capacity', …] }`, tried before the built-in
 * ones. They are matched as literal phrases, any case, with the same unit handling ("Capacity (Ah) 100" gives
 * 100 Ah). A field with no labels of its own (product name, frame…) takes the rest of the label's line. Anything
 * that isn't a list of non-blank strings under a field's name is ignored.
 */
export function withSynonyms(custom) {
  const taught = (f) => {
    const l = custom?.[f.name];
    return Array.isArray(l) ? l.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : [];
  };
  const merge = (set) => set.map((f) => {
    const labels = taught(f);
    if (!labels.length) return f;
    return f.labels ? { ...f, labels: [...labels, ...f.labels] } : { ...f, labels, find: (t) => restOfLine(t, { labels }) ?? f.find(t, f) };
  });
  return { battery: merge(FIELDS), solar: merge(SOLAR_FIELDS) };
}

/**
 * A solar sheet also gets one variant per power class, named by its STC Pmax ("625 W"); `fields` is then the
 * highest-power variant's. `custom`: the user's labels, as for withSynonyms().
 * @returns {{ name: string, type: 'battery'|'solar', variants?: { name: string, fields: Fields }[], fields: Fields }}
 * @typedef {Record<string, { value: number|string, unit: string, raw: string }>} Fields
 */
export function normalise(text, fileName = '', custom = undefined) {
  const t = clean(text);
  const type = detectType(t);
  const fields = Object.fromEntries(withSynonyms(custom)[type].map((f) => [f.name, f.find(t, f) ?? { value: '', unit: '', raw: '' }]));
  const file = String(fileName ?? '');
  if (!fields['Product name'].value && file) fields['Product name'] = { value: file.replace(/\.pdf$/i, ''), unit: '', raw: file };
  const name = fields['Product name'].value;
  if (type === 'battery') return { name, type, fields };
  // Variant i takes the i-th number of each series row, or a one-number row's only number; every other row as is.
  const pick = (i) => Object.fromEntries(Object.entries(fields).map(([k, f]) => {
    if (!Array.isArray(f.value)) return [k, f];
    const v = f.value[f.value.length === 1 ? 0 : i];
    return [k, v === undefined ? { value: '', unit: '', raw: '' } : { ...f, value: v }];
  }));
  // As many classes as most series rows have: a drawing's dimensions printed on the Pmax row's line ("… 370 375
  // 1011 35") are no classes.
  const counts = Object.values(fields).filter((f) => Array.isArray(f.value) && f.value.length > 1).map((f) => f.value.length);
  const classes = counts.reduce((a, b) => (counts.filter((n) => n === b).length > counts.filter((n) => n === a).length ? b : a), counts[0]);
  const pmax = (fields['Max power Pmax'].value || []).slice(0, classes);
  const variants = pmax.map((w, i) => ({ name: `${w} W`, fields: pick(i) }));
  if (!variants.length) return { name, type, fields: pick(0) };
  return { name, type, variants, fields: variants[pmax.indexOf(Math.max(...pmax))].fields };
}

/** The file name a URL ends in, decoded, without query or hash: "Datasheet.pdf" for ".../files/Datasheet.pdf?v=2"; '' for none. */
export function nameFromUrl(url) {
  let name = '';
  try {
    name = new URL(url).pathname.split('/').pop();
    return decodeURIComponent(name);
  } catch {
    return name; // no URL: ''; a stray "%" in the name: as written
  }
}

/** One page's pdf.js text items as visual lines: top to bottom, left to right. */
export function pageText(items) {
  const lines = [];
  const sorted = items
    .filter((it) => it.str?.trim() && !it.transform[1]) // rotated text (side notes) is never part of a table row
    .map(({ str, transform: [, , , d, x, y], width, height }) => ({ str, x, y, w: width, h: height || Math.abs(d) || 1 }))
    .sort((a, b) => b.y - a.y);
  for (const it of sorted) {
    const line = lines.at(-1);
    // Same row when the baselines are within half a text height: a label and its value are often 1-2 pt
    // apart, and superscripts (footnote marks, a raised "o" used as a degree sign) sit a little higher.
    // The tallest item so far is the row's reference, so a superscript sorted first doesn't split its row.
    if (line && line.y - it.y < Math.max(line.h, it.h) / 2) {
      line.items.push(it);
      if (it.h > line.h) Object.assign(line, { y: it.y, h: it.h });
    } else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  return lines
    .map(({ items: row }) => {
      row.sort((a, b) => a.x - b.x);
      // pdf.js splits words into several items; only a visible gap means a space.
      const s = row.reduce((acc, it, i) => acc + (i && it.x - row[i - 1].x - row[i - 1].w > it.h * 0.15 ? ' ' : '') + it.str, '');
      return s.replace(/\s+/g, ' ').trim();
    })
    .join('\n');
}

function clean(text) {
  return String(text ?? '')
    .replace(/º/g, '°') // U+00BA as a degree sign, "(ºC)", "%/ºC": NFKC would make it an "o"
    .normalize('NFKC') // ligatures, full-width ":", "℃" -> "°C"
    .replace(/[\0-\t\v\r\x0e-\x1f\x7f]/g, ' ') // keeps \n and the \f between pages; some fonts map "(" to \x1e
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\bN ?([MO]) ?([OC]) ?T\b/g, 'N$1$2T') // a column header spelt out "STC N O C T STC N O C T"
    // Degree signs as fonts really encode them: "°", "˚" (NFKC made it a space and U+030A), a raised "o"
    // ("0~55oC"), even "∞" ("-10 ∞C").
    .replace(/(\d[^\S\n]*)(?:[°\u030a∞]|o(?=[^\S\n]*[CF]\b))[^\S\n]*([CF])\b/g, '$1°$2');
}

// A footnote ("* …", "[1] …", "(2) …", "3) …", "1. …") gives test conditions and exceptions, never the spec
// itself: "*** The maximum charging/discharging current of SBR064 is 20A when used with …".
const FOOTNOTE = /^[^\S\n]*(?:\*|\[\d+\]|\(\d+\)|\d+[.)][^\S\n])/;
// Every match of a field's first label, then of its next one, and so on: labels go most specific first, so
// "Nominal energy 10 kWh" beats "a capacity of 5 kWh" further up the page.
const matches = (t, f, rest) =>
  f.labels.flatMap((l) => [...t.matchAll(new RegExp(`(?<![a-z])(?:${l.replaceAll(' ', '\\s+')})(?![a-z])${rest}`, 'gid'))])
    .filter((m) => !FOOTNOTE.test(t.slice(t.lastIndexOf('\n', m.index) + 1, m.index + 1)));
const found = (t, m, value, unit) => ({ value, unit, raw: snippet(t, m.index, m[0].length) });
const snippet = (t, at, len) => t.slice(Math.max(0, at - 20), at + len + 40).replace(/\s+/g, ' ').trim();
const unitOf = (s) => UNITS[s.toLowerCase().replace(/[\s°]/g, '')];
// A unit written in the label or between it and the number ("Weight (Kg) 38", a taught "Capacity (Ah)"): the
// last one before the number. m's group 1 is the gap.
const unitIn = (t, m, units) => [...t.slice(m.index, m.indices[1][1]).matchAll(new RegExp(`(?<![a-z])(?:${units})(?![a-z])`, 'gi'))].at(-1)?.[0];
const scale = (n, factor) => (factor === 1 ? n : +(n * factor).toPrecision(5));

// A comma is the decimal mark ("5,12", "1.234,5") unless exactly 3 digits follow it in a number with no
// decimal point ("26,400") or a decimal point comes after it ("1,234.5").
function toNumber(s) {
  if (s.lastIndexOf(',') > s.lastIndexOf('.') && !/^[-+]?\d{1,3}(?:,\d{3})+$/.test(s)) s = s.replaceAll('.', '').replace(',', '.');
  return Number(s.replaceAll(',', ''));
}

function number(t, f) {
  for (const units of f.units) {
    // A range ("90-100 %") gives its first number, and so does a tolerance ("80 ± 10 %", "80+-10%").
    // (?!/?[a-z]): a ratio ("160 Wh/kg") is no value.
    // (?!…[%°]): "6000 cycles with 80 % DoD" or "at 25°C" must not give 80 or 25 cycles.
    const rest = `(${GAP})${FREE}(${NUM})(?:${H}(?:~|-|to)${H}${NUM})?(?:${H}(?:±|\\+/?-)${H}${NUM})?${H}\\+?${H}(${units})?(?!/?[a-z])(?!${H}[%°])`;
    for (const m of matches(t, f, rest)) {
      const n = toNumber(m[2]);
      const [unit, factor] = unitOf(m[3] ?? unitIn(t, m, units) ?? '') ?? (f.unitless ? [f.unit, 1] : []);
      if (unit && !Number.isNaN(n)) return found(t, m, scale(n, factor), unit);
    }
  }
  const m = f.bare && new RegExp(f.bare, 'i').exec(t); // e.g. "6000 cycles" with no label
  return m ? found(t, m, toNumber(m[1]), f.unit) : undefined;
}

// "STC NOCT STC NOCT …": a table that gives each power class a column per test condition (BNPI and BSTC are
// bifacial ones).
const COLUMNS = /\b(?:STC|NOCT|NMOT|BNPI|BSTC)(?:[^\S\n]+(?:STC|NOCT|NMOT|BNPI|BSTC))+\b/i;
const NMOT = /\bN(?:MOT|OCT)\b/i;

// All the numbers of a table row, one per power class: "Maximum Power (Pmax) 600.00 451.00 605.00 …",
// "Pmax 570Wp 429Wp …"; "#" holds the place of a class the row has no value for. STC values only: the first row
// whose label doesn't name NMOT or NOCT, a table row (several numbers) before a one-number mention ("Module
// efficiency up to 23.7 %" on page 1), and of a table that interleaves STC with NOCT or BNPI columns, the STC
// ones. at: 'NMOT' takes the NOCT columns instead, or else the same row repeated after a mention of NMOT or NOCT
// (a separate NMOT table further down), never one labelled STC (the next module family's).
function series(t, f) {
  // Any V or A as a unit ("12.99V" in a row of amps is a typo, not the row's end), but "-0.29%/°C" is a
  // coefficient, never Voc.
  const n = `${FREE}${NUM}(?:${H}(?:${f.units[0]}|V|A))?(?![a-z]|${H}[%°/])`;
  const rows = matches(t, f, `(${GAP})(${n}(?:${H}(?:${n}|#))*)`);
  const nums = (m) => m[2].match(new RegExp(`${NUM}|#`, 'g')).map((s) => (s === '#' ? undefined : toNumber(s)));
  const stcRows = rows.filter((m) => !NMOT.test(m[1]));
  const stc = stcRows.find((m) => nums(m).length > 1) ?? stcRows[0];
  if (!stc) return;
  const cols = COLUMNS.exec(t)?.[0].split(/\s+/);
  const columns = (re) => nums(stc).filter((_, i) => re.test(cols[i]));
  const split = cols?.length === nums(stc).length;
  if (!f.at) return found(t, stc, split ? columns(/^STC$/i) : nums(stc), f.unit);
  if (split) return found(t, stc, columns(NMOT), f.unit);
  const m = rows.find((r) => r.index > stc.index && !/\bSTC\b/i.test(r[1]) && NMOT.test(t.slice(stc.index, r.index + r[0].length)));
  return m && found(t, m, nums(m), f.unit);
}

// "min–max" strings: voltage windows and temperatures (°F converted to °C). A sign may stand apart ("- 40°C to
// + 85°C"), and "0<T<50°C" is a range too.
function range(t, f) {
  const u = `(${f.units[0]})?`;
  const n = `((?:[-+]${H})?${NUM})`;
  for (const m of matches(t, f, `(${GAP})${FREE}${n}${H}${u}${H}(?:~|-|to|[<≤]${H}T${H}[<≤])${H}${n}${H}${u}(?![a-z])`)) {
    const unit = m[5] ?? m[3] ?? unitIn(t, m, f.units[0]);
    if (!unit) continue; // "230/195-253 VAC" has no V the field accepts
    const conv = /f$/i.test(unit) ? (x) => +(((x - 32) * 5) / 9).toPrecision(5) : (x) => x;
    const [a, b] = [m[2], m[4]].map((s) => conv(toNumber(s.replace(/\s/g, ''))));
    if (!Number.isNaN(a + b)) return found(t, m, `${a}–${b}`, f.unit);
  }
}

// Kept as printed, converted to mm; the order ("H×W×D") is added when the sheet states it, in the label
// (letters or words: "Length × Width × Thickness") or on each side ("2382(L) × 1134(W) × 30(T)").
function dimensions(t, f) {
  const side = `(${NUM})${H}(${f.units[0]})?${H}(?:\\([LWHDT]\\)${H})?`;
  for (const m of matches(t, f, `(${GAP})${FREE}${side}[x×*]${H}${side}[x×*]${H}${side}(?![a-z])`)) {
    const [, factor] = unitOf(m[7] ?? m[5] ?? m[3] ?? unitIn(t, m, f.units[0]) ?? 'mm');
    const sides = [m[2], m[4], m[6]].map((s) => (factor === 1 ? toNumber(s) : Math.round(toNumber(s) * factor)));
    const tags = m[0].match(/\([LWHDT]\)/g) ?? [];
    const named = m[0].match(new RegExp(`(?<![a-z])${ORDER}(?![a-z])`, 'i'))?.[0].split(/\s?[xX×*/]\s?/) ?? (tags.length === 3 ? tags : []);
    const order = named.map((s) => s.replace(/\W/g, '')[0].toUpperCase()).join('×');
    if (!sides.some(Number.isNaN)) return found(t, m, sides.join(' × ') + (order ? ` (${order})` : ''), f.unit);
  }
}

function ipRating(t, f) {
  const IP = '([Il]P ?[\\dX]{2})(?!\\w)'; // "lP20" is a real typo
  const m = matches(t, f, `${GAP}${IP}`)[0] ?? new RegExp(`(?<![a-z])${IP}`, 'i').exec(t);
  return m && found(t, m, m[1].replace(/\s/g, '').replace(/^l/i, 'I').toUpperCase(), '');
}

function chemistry(t) {
  const m = /(\bLFP\b|LiFePO|lithium[\s-]iron[\s-]phosphate)|(\bN(?:MC|CM)\b|nickel[\s-]manganese[\s-]cobalt)|(\bLTO\b|lithium[\s-]titanate)/i.exec(t)
    ?? /\bNCA\b|\bLCO\b|\bLMO\b|sodium[\s-]ion|lead[\s-]acid/i.exec(t);
  return m && found(t, m, m[1] ? 'LFP' : m[2] ? 'NMC' : m[3] ? 'LTO' : 'other', '');
}

// Kept as printed, with its unit (W or %): "Power Tolerance 0~+5W" gives "0~+5" W, "±3 %" gives "±3" %,
// "0 ~ + 10 W" gives "0 ~ + 10" W.
function tolerance(t, f) {
  for (const m of matches(t, f, `(${GAP})(±?${H}${NUM}(?:${H}(?:~|/|-|to)${H}(?:[-+]${H})?${NUM})?)${H}(%|Wp?)?(?![a-z])`)) {
    const unit = m[3] ?? unitIn(t, m, '%|Wp?');
    if (unit) return found(t, m, m[2].replace(/\s+/g, ' '), unit === '%' ? '%' : 'W');
  }
}

// By precedence, not first-found: a TOPCon sheet often compares itself with PERC.
const TECHS = [['TOPCon', /\bTOPCon\b/i], ['HJT', /\bHJT\b|hetero[\s-]?junction/i], ['mono PERC', /\bPERC\b/i]];
function cellTech(t) {
  const [tech, m] = TECHS.map(([name, re]) => [name, re.exec(t)]).find(([, hit]) => hit) ?? [];
  const bifacial = /bi-?facial/i.exec(t);
  return (m || bifacial) && found(t, m ?? bifacial, [tech, bifacial && 'bifacial'].filter(Boolean).join(', '), '');
}

// The front glass thickness: "2 mm dual glass" when the sheet says dual glass, or has a rear or back glass
// ("Back Cover(Glass)") and no backsheet ("BACK GLASS BLACK BACK SHEET" is a backsheet), else "3.2 mm glass".
function glass(t, f) {
  const v = number(t, f);
  const dual = /(?:dual|double)[\s-]glass|glass[\s/-]glass/i.test(t) || (/(?:rear|back)(?: side| cover)?[^\S\n]*\(?glass/i.test(t) && !/back[\s-]?sheet/i.test(t));
  return v && { ...v, value: `${v.value} mm ${dual ? 'dual glass' : 'glass'}`, unit: '' };
}

// The material, cut after it: "Frame: 30 mm anodized aluminium alloy, silver" gives "30 mm anodized aluminium alloy".
function frame(t) {
  const m = /\bframe(?: material)?\b[^\S\n]*:?[^\S\n]*([^\n]*?(?:alumin(?:i?um)(?:[^\S\n]+alloy)?|alloy|steel))/i.exec(t);
  return m && found(t, m, m[1], '');
}

// A connector model has a digit ("MC4", "MC4-EVO2", "T4", "QC4.10"), maybe after its maker ("Stäubli:
// PV-KST4") or a voltage rating ("1000V:Staubli MC4"); else an MC4 named anywhere.
function connector(t) {
  const m = /\bconnectors?(?: type)?\b[^\S\n]*:?[^\S\n]*(?:\d+[^\S\n]*V(?:DC)?[^\S\n]*:[^\S\n]*)?((?:St[aä]ubli:? |Amphenol:? )?(?!\d+[^\S\n]*V\b)[\w./-]*\d[\w./-]*(?: compatible)?)/i.exec(t)
    ?? /\bMC4\b(?:[ -]?EVO ?2A?)?(?: compatible)?/i.exec(t);
  return m && found(t, m, m[1] ?? m[0], '');
}

function certifications(t, f) {
  const hits = (f.certs ?? CERTS).map(([name, re]) => [name, re.exec(t)]).filter(([, m]) => m);
  if (!hits.length) return;
  const first = hits.reduce((a, b) => (b[1].index < a[1].index ? b : a))[1];
  return found(t, first, hits.map(([name]) => name).join(', '), '');
}

function manufacturer(t, f) {
  const counts = (f.brands ?? BRANDS).map((b) => [b, [...t.matchAll(new RegExp(`\\b${b.replaceAll(' ', '[\\s-]?')}`, 'gi'))]]);
  const [brand, hits] = counts.reduce((a, b) => (b[1].length > a[1].length ? b : a));
  return hits.length ? found(t, hits[0], brand, '') : undefined;
}

// The first line of page 1 that looks like a model name ("US5000", "Powerwall 3"): short, with a letter
// and a digit, and not a URL, e-mail, year, version, a quantity like "38.4 kWh" or "storage of 51 kWh", a
// percentage ("EFFICIENCY UPTO 21.5%"), a standard ("IS/IEC 61730"), a phone or registration number, or a
// generic "LiFePO4 Battery Module".
function productName(t) {
  const line = t.split('\f')[0].split('\n').map((s) => s.trim()).find((s) =>
    s.length <= 40 && s.split(' ').length <= 5 && /[a-z]/i.test(s) && /\d/.test(s)
    && !/^[\d.,+-]|www\.|@|https?:|\b(?:19|20)\d\d\b|^v\d|LiFePO4?|%|\b(?:IEC|ISO|UL)\b|\d{5}|\d ?(?:[kM]?Wh?|V|m?Ah|kg|mm)\b/i.test(s));
  return line && { value: line, unit: '', raw: line };
}

// A taught label on a field with no labels of its own: the rest of its line ("Model: SMILE-G3-BAT-10.1P").
function restOfLine(t, f) {
  const m = matches(t, f, `(${H}[:|=-]*${H})(\\S[^\\n]*)`)[0];
  return m && found(t, m, m[2].trim(), '');
}
