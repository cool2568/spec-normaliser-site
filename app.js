import * as pdfjs from './vendor/pdf.min.mjs';
import { BILLING, license } from './license.js';
import { FIELD_SETS, nameFromUrl, normalise, pageText } from './normalise.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const MAX = 10; // Pro and the free beta; the free version takes BILLING.freeLimit
const $ = (id) => document.getElementById(id);
const el = (tag, props, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};
const products = []; // normalise() results plus the file name and text, in column order; p.fields is the variant shown
const add = (file, text) => products.push({ file, text, ...normalise(text, file, synonyms) });

// Status as toasts, bottom right: a problem stays until dismissed, a 'busy' one until its caller removes it, any
// other goes after a few seconds. Both regions are aria-live; while Settings is open its own takes the toasts, as a
// modal dialog hides the page's from sight and from screen readers.
function toast(text, kind = 'info') {
  const t = el('div', { className: `toast ${kind}` }, el('p', { textContent: text }));
  if (kind === 'problem') t.append(el('button', { type: 'button', className: 'icon-btn', textContent: '×', ariaLabel: 'Dismiss', onclick: () => t.remove() }));
  if (kind === 'info') setTimeout(() => t.remove(), 5000);
  $($('settings').open ? 'drawer-toasts' : 'toasts').append(t);
  return t;
}

// The user's own labels, { 'Field name': ['label as printed', …] }, kept in localStorage "synonyms" and tried
// before the built-in ones. Stored and imported maps are untrusted: merge() keeps known fields' non-blank labels.
const NAMES = new Set(Object.values(FIELD_SETS).flat().map((f) => f.name));
const merge = (into, from) => {
  for (const [name, labels] of Object.entries(from ?? {})) {
    if (!NAMES.has(name) || !Array.isArray(labels)) continue;
    for (const l of labels) {
      const label = typeof l === 'string' ? l.trim().replace(/\s+/g, ' ') : '';
      if (label && !(into[name] ??= []).some((x) => x.toLowerCase() === label.toLowerCase())) into[name].push(label);
    }
  }
  return into;
};
const synonyms = (() => {
  try {
    return merge({}, JSON.parse(localStorage.getItem('synonyms')));
  } catch {
    return {}; // site data blocked: taught labels last until the page closes
  }
})();
const saveSynonyms = () => {
  try {
    localStorage.setItem('synonyms', JSON.stringify(synonyms));
  } catch {} // site data blocked: nowhere to keep them
};
const taughtCount = () => Object.values(synonyms).flat().length;
// license.js calls these inside try/catch: localStorage throws in some private windows.
const lic = license({ fetch, now: Date.now, storage: { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) } });
let plan = { key: '', status: 'free' }; // lic's state
const limit = () => (BILLING.freeBeta || plan.status === 'pro' ? MAX : BILLING.freeLimit);
let queue = lic.check().then(showPlan); // one batch at a time, so a second drop can't overshoot the limit; the first waits for the license

// "Nominal energy (kWh)"; a value in another unit than its row's (Ah in a kWh row) keeps its unit.
const rowLabel = (f) => (f.unit ? `${f.name} (${f.unit})` : f.name);
const cellText = ({ value, unit }, f) => (value === '' ? '' : unit && unit !== f.unit ? `${value} ${unit}` : String(value));
// The rows are the first product's type's. A product of the other type fills the rows its own type has too
// (name, maker, operating temperature, weight, certifications), and its dimensions whatever their order.
const tableType = () => products[0]?.type ?? 'battery';
const key = (name) => name.replace(/^Dimensions .*/, 'Dimensions'); // "Dimensions W×D×H" = "Dimensions L×W×H"
const valueOf = (p, f) => Object.entries(p.fields).find(([k]) => key(k) === key(f.name))?.[1];
const variantOf = (p) => p.variants?.find((v) => v.fields === p.fields);

// The table's row groups, in order; each keeps its fields in FIELDS order. A field not named here still shows, under
// "Other", so a field added to normalise.js can't go missing from the table or the copy.
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
const sections = () => {
  const fields = FIELD_SETS[tableType()];
  const groups = Object.entries(GROUPS[tableType()]).map(([title, names]) => [title, fields.filter((f) => names.includes(f.name))]);
  const rest = fields.filter((f) => !groups.some(([, group]) => group.includes(f)));
  return rest.length ? [...groups, ['Other', rest]] : groups;
};

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
// Which columns hold the row's best: numbers in the row's own unit only (never Ah against kWh), at least two of
// them, and not all equal (a dot on every cell says nothing). Ties all win.
function bestOf(f) {
  const score = BEST[f.name];
  if (!score) return [];
  const s = products.map((p) => {
    const v = valueOf(p, f);
    return typeof v?.value === 'number' && v.unit === f.unit ? score(v.value) : NaN;
  });
  const known = s.filter((x) => !Number.isNaN(x));
  const top = Math.max(...known);
  return known.length > 1 && known.some((x) => x !== top) ? s.map((x) => x === top) : [];
}

function addFiles(fileList) {
  const files = [...fileList]; // now: a drop's files and a cleared <input>'s list are gone later
  queue = queue.then(() => read(files)).catch((e) => toast(`Failed: ${e.message}`, 'problem'));
}

async function read(files) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const max = limit();
  const take = pdfs.slice(0, Math.max(0, max - products.length)); // removing a Pro key can leave more than the free limit
  const problems = files.filter((f) => !pdfs.includes(f)).map((f) => `${f.name}: not a PDF`);
  if (pdfs.length > take.length) {
    problems.push(`${pdfs.length - take.length} skipped: ${max} datasheets at most`);
    if (max < MAX) $('upsell').hidden = false; // the free limit: Upgrade, or enter a key
  }
  const busy = take.length ? toast('', 'busy') : null;
  let done = 0;
  for (const [i, file] of take.entries()) {
    busy.firstChild.textContent = `Reading ${i + 1} of ${take.length}: ${file.name}…`;
    try {
      const text = await pdfText(new Uint8Array(await file.arrayBuffer()));
      if (!text.trim()) throw new Error('no selectable text (a scanned image?)');
      add(file.name, text);
      render(); // the toolbar's strip shows how much of it came out, so the user knows where to teach a label
      done++;
    } catch (e) {
      problems.push(`${file.name}: ${e.name === 'PasswordException' ? 'password-protected' : e.message}`);
    }
  }
  if (busy) {
    busy.remove();
    toast(`Read ${done} of ${take.length} datasheet${take.length === 1 ? '' : 's'}.`);
  }
  if (problems.length) toast(problems.join('\n'), 'problem');
}

// Each page rebuilt into visual lines (see normalise.js), pages separated by "\f".
async function pdfText(data) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) pages.push(pageText((await (await pdf.getPage(i)).getTextContent()).items));
    return pages.join('\n\f\n');
  } finally {
    await task.destroy(); // also ends the worker
  }
}

// Every loaded datasheet read again with the taught labels; a power class picked in a column stays picked.
function rerun() {
  products.forEach((p, i) => {
    const q = { file: p.file, text: p.text, ...normalise(p.text, p.file, synonyms) };
    q.fields = q.variants?.find((v) => v.name === variantOf(p)?.name)?.fields ?? q.fields;
    products[i] = q;
  });
  render();
  renderSynonyms();
}

// A blank cell's "Teach label" opens a form under its dash. The label is saved under the product's own row name
// ("Dimensions L×W×H" for a module in a battery table) and every datasheet is read again; focus then lands on the
// cell, to hear what it found. Esc or Cancel closes the form, back on the cell's button.
function teach(td, button, i, f) {
  const p = products[i];
  const name = Object.keys(p.fields).find((k) => key(k) === key(f.name));
  const input = el('input', { className: 'field', required: true, pattern: '.*\\S.*', autocomplete: 'off', spellcheck: false,
    placeholder: 'Label exactly as printed', ariaLabel: `Label for ${f.name}, exactly as the ${p.name} datasheet prints it` });
  const cancel = el('button', { type: 'button', className: 'btn sm', textContent: 'Cancel' });
  const form = el('form', { className: 'teach-form' }, input, el('div', { className: 'row' }, el('button', { className: 'btn sm primary', textContent: 'Save' }), cancel));
  const close = () => {
    form.remove();
    td.className = 'blank';
    button.focus();
  };
  cancel.onclick = close;
  form.onkeydown = (e) => {
    if (e.key === 'Escape') close();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const taught = input.value.trim().replace(/\s+/g, ' ');
    merge(synonyms, { [name]: [taught] });
    saveSynonyms();
    rerun();
    const has = products.filter((q) => q.fields[name]);
    toast(`Saved "${taught}" for ${name}: found in ${has.filter((q) => q.fields[name].value !== '').length} of ${has.length} datasheets.`);
    const cell = rowOf.get(f.name)?.cells[i + 1];
    if (cell) {
      cell.tabIndex = -1;
      cell.focus();
    }
  };
  td.className = 'blank teaching';
  td.append(form);
  input.focus();
}

function renderSynonyms() {
  const entries = Object.entries(synonyms);
  $('taught').replaceChildren(...entries.map(([name, labels]) => el('li', {}, el('span', { className: 'taught-field', textContent: name }),
    el('div', {}, ...labels.map((label) => {
      const remove = el('button', { type: 'button', className: 'icon-btn', textContent: '×', title: 'Remove', ariaLabel: `Remove "${label}" from ${name}` });
      remove.onclick = () => {
        synonyms[name] = synonyms[name].filter((l) => l !== label);
        if (!synonyms[name].length) delete synonyms[name];
        saveSynonyms();
        rerun();
        toast(`Removed "${label}" from ${name}.`);
      };
      return el('span', { className: 'tag' }, el('q', { textContent: label }), remove);
    })))));
  if (!entries.length) $('taught').append(el('li', { className: 'muted', textContent: 'None yet. Hover a blank cell in the table and use Teach label.' }));
  $('synonyms-count').textContent = entries.length ? String(taughtCount()) : '';
  $('export').disabled = !entries.length;
}

// The empty state until the first datasheet; then the toolbar, its strip and the table.
function render() {
  $('empty').hidden = products.length > 0;
  $('workspace').hidden = !products.length;
  $('copy').disabled = !products.length;
  if (!products.length) return;
  renderHead();
  renderBody();
  renderStrip();
}

// Each datasheet's column header: its name (in full on hover, with the file), maker, power class and remove.
function renderHead() {
  const corner = el('th', { scope: 'col' }, el('span', { className: 'corner', textContent: tableType() === 'solar' ? 'Solar modules' : 'Battery storage' }));
  $('thead').replaceChildren(el('tr', {}, corner, ...products.map((p, i) => {
    const remove = el('button', { type: 'button', className: 'icon-btn', textContent: '×', title: 'Remove', ariaLabel: `Remove ${p.name}` });
    remove.onclick = () => {
      products.splice(i, 1);
      render();
      toast(`Removed ${p.name}.`);
      $(products.length ? 'add' : 'choose').focus();
    };
    const th = el('th', { scope: 'col', className: 'product' }, el('div', { className: 'ph' }, el('div', { className: 'ph-text' },
      el('span', { className: 'ph-name', textContent: p.name, title: `${p.name}\n${p.file}` }),
      el('span', { className: 'ph-maker', textContent: p.fields.Manufacturer?.value || p.file })), remove));
    if (p.variants?.length > 1) {
      // One option per power class. Picking one redraws the body only (best values can move to another column),
      // so focus stays on the select.
      const pick = el('select', { className: 'pill', ariaLabel: `Power class of ${p.name}` },
        ...p.variants.map((v, j) => el('option', { value: j, textContent: v.name, selected: v.fields === p.fields })));
      pick.onchange = () => {
        p.fields = p.variants[pick.value].fields;
        renderBody();
        renderStrip();
      };
      th.append(pick);
    }
    return th;
  })));
}

// The rows, one <tbody> per group under a full-width divider row. The hover text is the snippet the value was read
// from, to check it against the sheet.
let bodies = [];
const rowOf = new Map(); // field name -> its <tr>
function renderBody() {
  for (const b of bodies) b.remove();
  rowOf.clear();
  bodies = sections().map(([title, fields]) => el('tbody', {},
    el('tr', { className: 'group' }, el('th', { scope: 'rowgroup', colSpan: products.length + 1 }, el('span', { textContent: title }))),
    ...fields.map((f) => {
      const best = bestOf(f);
      const numeric = products.some((p) => typeof valueOf(p, f)?.value === 'number');
      const tr = el('tr', { className: numeric ? 'num' : '' }, el('th', { scope: 'row', textContent: f.name }), ...products.map((p, i) => cell(p, f, i, best[i])));
      rowOf.set(f.name, tr);
      return tr;
    })));
  $('table').append(...bodies);
}

// A value with its unit after it (Ah in a kWh row keeps its own), "n/a" where the other type has no such row, and a
// dash with "Teach label" where nothing was found.
function cell(p, f, i, best) {
  const v = valueOf(p, f);
  if (!v) return el('td', { className: 'na', textContent: 'n/a', title: `Not a ${p.type} field` });
  if (v.raw) {
    const td = el('td', { className: best ? 'best' : '', title: v.raw }, el('span', { className: 'v', textContent: String(v.value) }));
    if (v.unit) td.append(el('span', { className: 'u', textContent: v.unit }));
    if (best) td.append(el('span', { className: 'vh best-note', textContent: ' (best)' }));
    return td;
  }
  const td = el('td', { className: 'blank' }, el('span', { className: 'dash', textContent: '—', ariaHidden: 'true' }));
  const button = el('button', { type: 'button', className: 'teach', textContent: 'Teach label', ariaLabel: `${f.name} not found in ${p.name}: teach its label` });
  button.onclick = () => teach(td, button, i, f);
  td.append(button);
  return td;
}

// The toolbar's count and, per datasheet, how many of its fields came out: where the gaps are, to teach a label.
function renderStrip() {
  $('count').textContent = `${products.length} of ${limit()} datasheets`;
  $('mixed').hidden = !products.some((p) => p.type !== tableType());
  $('mixed').textContent = `Mixed product types: showing ${tableType()} fields`;
  $('fill').replaceChildren(...products.map((p) => {
    const fields = Object.values(p.fields);
    const n = fields.filter((f) => f.value !== '').length;
    return el('li', { className: 'chip', title: p.file }, el('b', { textContent: p.name }),
      el('span', { className: 'meter', ariaHidden: 'true' }, el('i', { style: `width: ${(100 * n) / fields.length}%` })), `Filled ${n} of ${fields.length}`);
  }));
}

$('copy').onclick = async () => {
  // The header row names the source files; the "Product name" row below it has the extracted names, with the
  // variant shown ("G12R 625 W"). A row another type's product doesn't have is empty. Rows in the table's order.
  const text = (p, f) => {
    const s = cellText(valueOf(p, f) ?? { value: '' }, f);
    return f.name === 'Product name' && variantOf(p) ? `${s} ${variantOf(p).name}` : s;
  };
  const rows = [['File', ...products.map((p) => p.file)], ...sections().flatMap(([, fields]) => fields).map((f) => [rowLabel(f), ...products.map((p) => text(p, f))])];
  // A tab or line break would split a cell. Text from a PDF starting with = + @ or "-x" would run as a
  // formula in Sheets, so it gets a leading ' (temperatures like "-10–50" start with "-" and a digit).
  const tsv = rows.map((r) => r.map((c) => c.replace(/\s+/g, ' ').replace(/^(?:[=+@]|-(?!\d))/, "'$&")).join('\t')).join('\n');
  try {
    await navigator.clipboard.writeText(tsv);
    toast('Copied. Paste into Google Sheets.');
  } catch (e) {
    toast(`Copy failed: ${e.message}`, 'problem');
  }
};
$('best').onchange = (e) => $('table').classList.toggle('show-best', e.target.checked);

// The whole page takes drops, so a near miss doesn't open the PDF in place of the table.
const dragging = (on) => document.documentElement.classList.toggle('dragging', on);
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  dragging(true);
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dragging(false); // left the window
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragging(false);
  addFiles(e.dataTransfer.files);
});
$('choose').onclick = $('add').onclick = () => $('files').click();
$('files').onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = ''; // picking the same file again still fires change
};

// The Chrome side panel (manifest.json): Add PDF from this tab reads the PDF in the tab whose toolbar icon was clicked
// (background.js keeps that tab in session storage; the click grants activeTab) and hands it to addFiles() as a
// dropped file. A site that activeTab doesn't open to this page's fetch is asked for as an optional host permission.
// fetch() refuses file: URLs, so a local PDF goes through XMLHttpRequest, which reads it once "Allow access to file
// URLs" is on for the extension.
if (document.documentElement.dataset.context === 'extension') {
  const readLocal = (url) => new Promise((resolve, reject) => {
    const x = Object.assign(new XMLHttpRequest(), { responseType: 'blob', onload: () => resolve(x.response), onerror: reject });
    x.open('GET', url);
    x.send();
  });
  const isPdf = async (blob) => !!blob && (await blob.slice(0, 1024).text()).includes('%PDF-'); // as PDF readers: in the first 1 KB
  const ask = (origins) => chrome.permissions.request({ origins: [origins] }).catch(() => null); // null: no user activation left
  let again = ''; // the site whose prompt came too late after its click, asked for first on the next click

  // The tab's PDF as a Blob, or the sentence that says why not. early: the retried prompt's answer, for again.
  const tabPdf = async (url, retry, early) => {
    const { host, origin, protocol } = new URL(url);
    if (protocol === 'file:') {
      const blob = await readLocal(url).catch(() => null);
      return (await isPdf(blob)) ? blob : 'This is a local file. Drag it into the panel, or turn on "Allow access to file URLs" for this extension in chrome://extensions and try again.';
    }
    const get = () => fetch(url, { credentials: 'include' }).then((r) => (r.ok ? r.blob() : null)).catch(() => undefined); // undefined: blocked (CORS) or offline
    let blob = await get(); // activeTab may cover it
    if (blob === undefined && /^https?:$/.test(protocol)) {
      const pattern = `${origin}/*`;
      const granted = await (retry === pattern ? early : ask(pattern));
      if (granted === null) {
        again = pattern;
        return `Click Add again to grant access to ${host}.`;
      }
      if (!granted) return `Access to ${host} was not granted. Download the PDF and drop it here.`;
      blob = await get();
    }
    if (!blob) return `Chrome blocked reading this tab (${host}). Download the PDF and drop it here.`;
    return (await isPdf(blob)) ? blob : `This tab (${host}) is not a PDF. Open the PDF itself, then try again.`;
  };

  $('choose-tab').onclick = $('add-tab').onclick = async () => {
    // A permission prompt needs this click's user activation, which lasts a few seconds: a retried site is asked for
    // now, before anything is awaited.
    const retry = again;
    const early = retry ? ask(retry) : null;
    again = '';
    const { activeTabPdf: clicked } = await chrome.storage.session.get('activeTabPdf');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!clicked?.url || clicked.tabId !== tab?.id) return toast('Click the Spec Sheet Normaliser icon on the tab that shows the PDF.', 'problem');
    const url = tab.url ?? clicked.url; // the tab's page now, where Chrome shows it; else the page the icon was clicked on
    const urlName = nameFromUrl(url);
    const name = /\.pdf$/i.test(urlName) ? urlName : `${(tab.title || clicked.title || 'datasheet').replace(/\.pdf$/i, '')}.pdf`;
    const busy = toast(`Fetching ${name}…`, 'busy');
    const pdf = await tabPdf(url, retry, early);
    busy.remove();
    if (typeof pdf === 'string') toast(pdf, 'problem');
    else addFiles([new File([pdf], name, { type: 'application/pdf' })]);
  };
}

// Synonyms: a team shares one dictionary as synonyms.json; an import adds to the labels already here.
$('export').onclick = () =>
  el('a', { href: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(synonyms, null, 2))}`, download: 'synonyms.json' }).click();
$('import-button').onclick = () => $('import').click();
$('import').onchange = async (e) => {
  const [file] = e.target.files;
  e.target.value = ''; // importing the same file again still fires change
  if (!file) return;
  try {
    const before = taughtCount();
    merge(synonyms, JSON.parse(await file.text()));
    saveSynonyms();
    rerun();
    toast(`Imported ${taughtCount() - before} new labels from ${file.name}.`);
  } catch (err) {
    toast(`Import failed: ${file.name} is not a synonyms JSON file (${err.message}).`, 'problem');
  }
};
renderSynonyms();

// Theme: system, light or dark, kept in localStorage "theme"; boot.js applies it before the first paint.
$('theme').elements.theme.value = document.documentElement.dataset.theme ?? 'system';
$('theme').onchange = (e) => {
  const theme = e.target.value;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {} // site data blocked: this visit only
};

// Settings: a modal drawer; Esc, its × or a click on the backdrop closes it.
const settings = $('settings');
$('open-settings').onclick = () => settings.showModal();
$('close-settings').onclick = () => settings.close();
settings.onclick = (e) => {
  if (e.target === settings) settings.close(); // the drawer's body fills it, so only the backdrop is the dialog itself
};
$('have-key').onclick = () => {
  settings.showModal();
  $('key').focus();
};
$('close-upsell').onclick = () => {
  $('upsell').hidden = true;
};

// Pro: hidden in the free beta. A stored key (Pro, or offline for over 14 days) can only be removed.
$(BILLING.freeBeta ? 'beta' : 'pro').hidden = false;
$('upgrade').href = $('upsell-upgrade').href = BILLING.checkoutUrl;
$('limit').prepend('Pro removes the limit. ');
$('upsell-text').textContent = `Free version compares ${BILLING.freeLimit} datasheets at a time. Pro removes the limit.`;

function showPlan(s) {
  plan = s;
  const pro = s.status === 'pro';
  $('plan').textContent = pro ? 'Pro: no limits.' : `Free version: ${BILLING.freeLimit} datasheets at a time.`;
  $('badge').textContent = BILLING.freeBeta ? 'Free · no limits' : pro ? 'Pro' : `Free · ${BILLING.freeLimit} at a time`;
  $('badge').className = pro ? 'badge pro' : 'badge';
  $('limit').hidden = pro;
  $('activate').hidden = !!s.key;
  $('remove').hidden = !s.key;
  if (pro) $('upsell').hidden = true;
  $('drop-sub').textContent = `Battery storage or solar module PDFs, up to ${limit()} at a time, anywhere on this page.`;
  if (products.length) renderStrip(); // its count shows the limit
}

$('activate').onsubmit = async (e) => {
  e.preventDefault();
  e.submitter.disabled = true; // a double click must not use up two activations
  const busy = toast('Activating…', 'busy');
  try {
    showPlan(await lic.activate($('key').value));
    toast(plan.status === 'pro' ? 'Pro activated: no limits.' : 'Activated, but this browser blocks site data, so it cannot keep the key.', plan.status === 'pro' ? 'info' : 'problem');
  } catch (err) {
    toast(`Activation failed: ${err.message}`, 'problem');
  }
  busy.remove();
  e.submitter.disabled = false;
};
$('remove').onclick = async () => {
  const [note, kind] = await lic.remove().then(() => ['Key removed.', 'info'], (err) => [`Key removed, but Dodo Payments did not free its activation: ${err.message}`, 'problem']);
  showPlan(await lic.check()); // no key now, so no request
  toast(note, kind);
};

// Dev only: ?demo (two battery sheets) or ?demo=solar (two module sheets) fills the table from the tests' fixture
// text, to look at the page without PDFs. demo.js is never loaded otherwise.
const demo = new URLSearchParams(location.search).get('demo');
if (demo !== null) {
  queue = queue.then(async () => {
    const { DEMO } = await import('./demo.js');
    for (const [file, text] of DEMO[demo] ?? DEMO.battery) add(file, text);
    render();
    toast(`Demo: ${products.length} datasheets from the test fixtures.`);
  });
}
