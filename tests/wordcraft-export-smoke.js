import { createArchiveBlob, downloadBlob, ingestDocxFile } from '../docx-engine.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const frame = document.getElementById('editor');
const report = document.getElementById('report');
const snapshots = new Map();
const controls = [...document.querySelectorAll('#controls button')];
let active = null;
let archive = null;
const log = message => { report.textContent += `\n${message}`; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inspect(blob) {
  const zip = await JSZip.loadAsync(blob);
  const xml = await zip.file('word/document.xml').async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Exported document XML is malformed.');
  const count = tag => doc.getElementsByTagNameNS(W, tag).length;
  const boldPreserved = [...doc.getElementsByTagNameNS(W, 'r')].some(run => {
    if (!run.textContent.includes('Strong emphasis')) return false;
    const bold = run.getElementsByTagNameNS(W, 'b')[0];
    return bold && !['0', 'false', 'off'].includes(bold.getAttributeNS(W, 'val'));
  });
  const relationsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  const relations = relationsXml ? new DOMParser().parseFromString(relationsXml, 'application/xml') : null;
  const hyperlinkPreserved = [...doc.getElementsByTagNameNS(W, 'hyperlink')].some(link => {
    const id = link.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    return [...(relations?.getElementsByTagNameNS('*', 'Relationship') || [])].some(relation =>
      relation.getAttribute('Id') === id && relation.getAttribute('Target')?.replace(/\/$/, '') === 'https://example.com'
    );
  });
  const text = [...doc.getElementsByTagNameNS(W, 'p')].map(paragraph =>
    [...paragraph.getElementsByTagName('*')]
      .filter(node => node.namespaceURI === W && ['t', 'delText'].includes(node.localName))
      .map(node => node.textContent).join('')
  ).join('\n');
  return { text, count, boldPreserved, hyperlinkPreserved };
}

async function exported(name) {
  const bytes = await frame.contentWindow.wordcraftExport(name);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

async function saveActive() {
  if (!active) return;
  snapshots.set(active, await exported(`job-${active}.docx`));
  log(`Saved edited snapshot for job ${active}.`);
}

async function load(key) {
  await saveActive();
  const blob = await (await fetch(`./fixtures/wordcraft-export-${key}.docx`)).blob();
  const win = frame.contentWindow;
  const transfer = new win.DataTransfer();
  transfer.items.add(new win.File([blob], `job-${key}.docx`));
  const canvas = win.document.getElementById('wordcraft_canvas');
  canvas.dispatchEvent(new win.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  canvas.dispatchEvent(new win.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  log(`Opening job ${key}. If WordCraft asks to save the previous sample, choose Don't Save: its edited snapshot is already captured above.`);
  // Confirm import through the actual exported document, rather than relying on a timer.
  const started = performance.now();
  while (true) {
    const result = await inspect(await exported(`job-${key}.docx`));
    if (result.text.includes(`JOB_${key.toUpperCase()}_ORIGINAL`)) break;
    if (performance.now() - started > 90000) throw new Error(`Job ${key} did not finish loading.`);
    await sleep(100);
  }
  active = key;
  log(`Loaded job ${key}.`);
}

function assert(value, message) {
  if (!value) throw new Error(`FAIL: ${message}`);
  log(`PASS: ${message}`);
}

async function baseline() {
  if (!active) throw new Error('Load a job first.');
  const result = await inspect(await exported(`job-${active}.docx`));
  assert(result.text.includes(`JOB_${active.toUpperCase()}_ORIGINAL`), 'Untouched DOCX exports and can be reopened.');
  assert(result.boldPreserved, 'Bold formatting survives export.');
  assert(result.count('tbl') > 0 && result.text.includes('Table value'), 'Table and cell text survive export.');
  assert(result.hyperlinkPreserved, 'Hyperlink and its target survive export.');
  assert(result.count('ins') > 0 && result.count('del') > 0, 'Existing tracked insertion and deletion survive export.');
}

async function verify() {
  await saveActive();
  assert(snapshots.has('a') && snapshots.has('b'), 'Both job snapshots are available.');
  archive = await createArchiveBlob([...snapshots].map(([key, blob]) => ({ name: `job-${key}.docx`, blob })));
  const zip = await JSZip.loadAsync(archive);
  assert(Object.keys(zip.files).length === 2, 'ZIP contains exactly two DOCX files.');
  for (const key of ['a', 'b']) {
    const blob = await zip.file(`job-${key}.docx`).async('blob');
    const result = await inspect(blob);
    assert(result.text.includes(`MANUAL_EDIT_JOB_${key.toUpperCase()}`), `Job ${key} retains its manual edit inside the ZIP.`);
    assert(!result.text.includes(`MANUAL_EDIT_JOB_${key === 'a' ? 'B' : 'A'}`), `Job ${key} does not contain the other job’s edit.`);
    const reopened = await ingestDocxFile(new File([blob], `job-${key}.docx`));
    assert(reopened.fullText.includes(`MANUAL_EDIT_JOB_${key.toUpperCase()}`), `Application DOCX engine can reopen edited job ${key}.`);
  }
  document.getElementById('download').disabled = false;
  log('COMPLETE: edited bulk export proof of concept passed.');
}

async function action(fn) {
  controls.forEach(button => { button.disabled = true; });
  try { await fn(); }
  catch (error) { log(error?.message || String(error)); }
  finally {
    controls.forEach(button => { button.disabled = false; });
    document.getElementById('download').disabled = !archive;
  }
}
document.getElementById('loadA').onclick = () => action(() => load('a'));
document.getElementById('loadB').onclick = () => action(() => load('b'));
document.getElementById('baseline').onclick = () => action(baseline);
document.getElementById('verify').onclick = () => action(verify);
document.getElementById('download').onclick = () => downloadBlob(archive, 'wordcraft-edited-jobs.zip');
frame.src = `../vendor/wordcraft/index.html?embed&export-test=${Date.now()}`;
const started = performance.now();
while (typeof frame.contentWindow?.wordcraftExport !== 'function') {
  if (performance.now() - started > 90000) {
    log('Export bridge is unavailable. Build the proof-of-concept patch, then reload this test page.');
    throw new Error('Export bridge unavailable');
  }
  await sleep(250);
}
controls.forEach(button => { button.disabled = button.id === 'download'; });
log('Export bridge ready. Load job A to begin.');
