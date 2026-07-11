import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

const src = readFileSync('./index.js', 'utf8');
let pass = 0, fail = 0;
const assert = (cond, name) => { cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name)); };

// --- extract a top-level function body from the real source by brace counting ---
function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error('not found: ' + name);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
}

// --- DOM + ST stubs ---
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.document = dom.window.document;

const fnSource = ['escapeHtml', 'highlightText', 'getActiveChatName', 'isActiveChatFile'].map(extract).join('\n');
const api = new Function('SillyTavern', 'document', fnSource +
    '\nreturn { escapeHtml, highlightText, getActiveChatName, isActiveChatFile };');

console.log('[1] XSS fix: real DOM round-trip proof');
{
    const { escapeHtml, highlightText } = api({ getContext: () => ({}) }, document);
    const evil = '<img src=x onerror=alert(1)> chat about stuff';
    const probe = document.createElement('div');

    // NEW code path: escape first, then highlight
    probe.innerHTML = highlightText(escapeHtml(evil), 'chat');
    assert(probe.querySelector('img') === null, 'fixed path: no <img> element ever created');
    assert(probe.textContent.includes('<img src=x onerror=alert(1)>'), 'fixed path: tag visible as literal text');
    assert(probe.querySelectorAll('span').length === 1, 'fixed path: highlight span still applied');

    // OLD code path (pre-fix): raw title straight into highlightText
    probe.innerHTML = highlightText(evil, 'chat');
    assert(probe.querySelector('img') !== null, 'sanity: old path really did create an <img> element (exploitable)');
}

console.log('[2] isActiveChatFile: solo chat via context.chatId');
{
    const { isActiveChatFile } = api({ getContext: () => ({ chatId: 'My Epic Chat' }) }, document);
    assert(isActiveChatFile('My Epic Chat.jsonl') === true, 'matches with .jsonl extension');
    assert(isActiveChatFile('My Epic Chat') === true, 'matches without extension');
    assert(isActiveChatFile('My Epic Chat 2.jsonl') === false, 'no prefix false-positive');
    assert(isActiveChatFile('') === false, 'empty fileName is false');
}

console.log('[3] isActiveChatFile: fallback to character card .chat field');
{
    const ctx = { chatId: undefined, characterId: 0, characters: [{ chat: 'Branch #2 - Old Story' }] };
    const { isActiveChatFile } = api({ getContext: () => ctx }, document);
    assert(isActiveChatFile('Branch #2 - Old Story.jsonl') === true, 'fallback path matches');
    assert(isActiveChatFile('Old Story.jsonl') === false, 'fallback path rejects parent chat');
}

console.log('[4] isActiveChatFile: numeric group chat_id survives String() coercion');
{
    const { isActiveChatFile } = api({ getContext: () => ({ chatId: 1720000000000 }) }, document);
    assert(isActiveChatFile('1720000000000.jsonl') === true, 'numeric group id matches file');
}

console.log('[5] isActiveChatFile: no context -> never throws, never matches');
{
    const { isActiveChatFile } = api({ getContext: () => { throw new Error('boom'); } }, document);
    assert(isActiveChatFile('Anything.jsonl') === false, 'throwing context handled');
}

console.log('[6] Observer split: static structure of the real file');
{
    const iio = extract('initIntersectionObserver');
    const io = extract('initObserver');
    assert(iio.includes('lazyObserver.disconnect') && !iio.includes('mutationObserver'), 'initIntersectionObserver touches ONLY lazyObserver');
    assert(io.includes('mutationObserver.disconnect') && !io.includes('lazyObserver'), 'initObserver touches ONLY mutationObserver');
    const noComments = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/\blet observer\b|[^a-zA-Z.]observer\.(observe|disconnect|unobserve)/.test(noComments), 'no bare shared observer usage remains (comments excluded)');
    const rb = extract('renderBatch');
    assert(rb.includes('lazyObserver.observe(sentinel)'), 'sentinels observed by lazyObserver');
}

console.log('[7] Reset wiring for scroll-once flag');
{
    const resets = (src.match(/[^t] activeScrolledThisOpen = false/g) || []).length; // excludes 'let activeScrolledThisOpen'
    assert(resets === 5, `flag reset in exactly 5 places, got ${resets}: CHAT_CHANGED, panel open click, char switch, failed-scroll release, popup-visible transition`);
    assert(extract('createFolderDOM').includes('tmc_has_active'), 'folder dot wired');
}


console.log('[8] buildActivityData: character filtering, rank density, branch map');
{
    const build = new Function(extract('buildActivityData') + '\nreturn buildActivityData;')();
    const items = [
        { file_id: 'Branch #1 - Old', avatar: 'A.png', chat_metadata: { main_chat: 'Old' } },
        { file_id: 'Fresh', avatar: 'A.png' },
        { file_id: 'OtherChar', avatar: 'B.png' },
        { file_id: 'GroupChat1', group: 'g1' },
        { file_id: 'Old', avatar: 'A.png', chat_metadata: {} },
        { file_id: 'RootStray' },
        null,
        { file_id: 42, avatar: 'A.png' },
        { file_id: 'Fresh', avatar: 'A.png' },
    ];
    const a = build(items, 'A.png');
    assert(JSON.stringify(a.rank) === JSON.stringify({ 'Branch #1 - Old': 0, 'Fresh': 1, 'Old': 2 }),
        'rank dense over survivors, other chars/groups/root/malformed/dupes excluded: ' + JSON.stringify(a.rank));
    assert(JSON.stringify(a.branchOf) === JSON.stringify({ 'Branch #1 - Old': 'Old' }), 'branch parentage from chat_metadata.main_chat only');
    const g = build(items, 'g1');
    assert(JSON.stringify(g.rank) === JSON.stringify({ 'GroupChat1': 0 }), 'group filtering by group id');
    const gn = build([{ file_id: 'GC', group: 1720000000 }], 1720000000);
    assert(gn.rank['GC'] === 0, 'numeric group id matches via String coercion');
    assert(JSON.stringify(build(undefined, 'A.png')) === JSON.stringify({ rank: {}, branchOf: {} }), 'non-array input safe');
}

console.log('[9] sortChats: activity rank ordering with date tie-break fallback');
{
    const mkSort = new Function('sortOrder', 'activityData',
        extract('getActivityRank') + '\n' + extract('sortChats') + '\nreturn sortChats;');
    const chats = [
        { fileName: 'Unranked2.jsonl', metadata: { name: 'unranked2', date: 111, msgCount: 0, size: 0 } },
        { fileName: 'Fresh.jsonl', metadata: { name: 'fresh', date: 500, msgCount: 0, size: 0 } },
        { fileName: 'Unranked.jsonl', metadata: { name: 'unranked', date: 999, msgCount: 0, size: 0 } },
        { fileName: 'Branch #1 - Old.jsonl', metadata: { name: 'branch #1 - old', date: 50, msgCount: 0, size: 0 } },
    ];
    const ranked = { charKey: 'A.png', fetchedAt: 0, rank: { 'Branch #1 - Old': 0, 'Fresh': 1 }, branchOf: {} };
    let out = mkSort('activity-desc', ranked)([...chats]).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Branch #1 - Old.jsonl', 'Fresh.jsonl', 'Unranked.jsonl', 'Unranked2.jsonl']),
        'activity-desc: fresh branch of OLD chat sorts FIRST (rank 0), unranked sink with date tie-break: ' + JSON.stringify(out));
    out = mkSort('activity-desc', { charKey: null, fetchedAt: 0, rank: {}, branchOf: {} })([...chats]).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Unranked.jsonl', 'Fresh.jsonl', 'Unranked2.jsonl', 'Branch #1 - Old.jsonl']),
        'fetch-failure degradation: no ranks -> pure message-date desc');
    out = mkSort('name-asc', ranked)([...chats]).map(c => c.fileName);
    assert(out[0] === 'Branch #1 - Old.jsonl' && out[1] === 'Fresh.jsonl', 'regression: name-asc unaffected by ranks');
}

console.log('[10] getBranchParent: extension stripping and miss behavior');
{
    const getBP = new Function('activityData', extract('getBranchParent') + '\nreturn getBranchParent;')(
        { charKey: 'A.png', fetchedAt: 0, rank: {}, branchOf: { 'X': 'Parent Chat' } });
    assert(getBP('X.jsonl') === 'Parent Chat', 'strips .jsonl before lookup');
    assert(getBP('X') === 'Parent Chat', 'bare name works');
    assert(getBP('Y.jsonl') === null, 'miss returns null');
    assert(getBP(null) === null, 'null-safe');
}

console.log('[11] v0.8.0 wiring: static structure of the real file');
{
    const rad = extract('refreshActivityData');
    const radCode = rad.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!radCode.includes('pinned'), 'refresh omits pinned param in code (would corrupt mtime rank)');
    assert(rad.includes('metadata: true') && rad.includes('/api/chats/recent'), 'requests /recent with metadata:true');
    assert(extract('performSync').includes('refreshActivityData()'), 'performSync kicks TTL-gated refresh');
    const srcNoComments = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!srcNoComments.includes('refreshActivityData(true)'), 'no force-refresh remains in code (v0.8.1: was firing full-library scan per chat open)');
    assert(src.includes('"activity-desc">Active (Recent)') || src.includes("value=\"activity-desc\">Active (Recent)"), 'dropdown has Active option');
    assert(src.includes("sortOrder: 'activity-desc'"), 'defaultSettings carries persisted default');
    assert(src.includes('getSettings().sortOrder = sortOrder'), 'onchange persists selection');
    assert(extract('createProxyBlock').includes('getBranchParent'), 'branch chip wired into proxy block');
}


const stripComments = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

console.log('[12] v0.8.1 perf wiring: fetch gated behind visible popup, observer scoped');
{
    const ps = stripComments(extract('performSync'));
    const gateIdx = ps.indexOf('if (!popup) return;');
    const fetchIdx = ps.indexOf('refreshActivityData()');
    assert(gateIdx > -1 && fetchIdx > gateIdx, 'refreshActivityData sits AFTER the popup-visible gate');
    const initFn = stripComments(extract('init'));
    assert(initFn.includes('activityData.fetchedAt = 0'), 'CHAT_CHANGED invalidates activity cache');
    assert(!initFn.includes('refreshActivityData'), 'CHAT_CHANGED never fetches directly');
    const io = stripComments(extract('initObserver'));
    assert(io.includes('getPopupNodes()') && io.includes('mutationObserver.observe(node'), 'observer attaches to popup nodes');
    assert(io.includes('document.body'), 'body observation kept only as fallback branch');
    assert(initFn.includes('syncPanelVisibility()') && initFn.includes('if (!userOpenedPanel) return;'), 'heartbeat reconciles visibility then early-outs when closed');
}

console.log('[13] syncPanelVisibility: open/close transitions and bulk-bar teardown');
{
    const mk = new Function('getPopupNodes', 'getComputedStyle', 'scheduleSync', 'clearSelection', 'state',
        'let userOpenedPanel = state.open; let activeScrolledThisOpen = true; let bulkMode = state.bulk; let selectedChats = state.sel;\n'
        + extract('syncPanelVisibility')
        + '\nreturn { run: syncPanelVisibility, state: () => ({ userOpenedPanel, activeScrolledThisOpen }) };');
    let synced = 0, cleared = 0;
    // hidden -> visible
    let h = mk(() => [{}], () => ({ display: 'flex' }), () => synced++, () => cleared++, { open: false, bulk: false, sel: new Set() });
    h.run();
    assert(h.state().userOpenedPanel === true && h.state().activeScrolledThisOpen === false && synced === 1, 'open transition: flag on, scroll reset, sync scheduled');
    // visible -> hidden with live bulk selection
    h = mk(() => [{}], () => ({ display: 'none' }), () => synced++, () => cleared++, { open: true, bulk: true, sel: new Set(['a']) });
    h.run();
    assert(h.state().userOpenedPanel === false && cleared === 1, 'close transition: flag off, bulk selection torn down');
}

console.log('[14] Content cache LRU: cap, eviction order, touch-refresh');
{
    const capMatch = src.match(/const CONTENT_CACHE_MAX = (\d+);/);
    assert(!!capMatch, 'cap constant present');
    const cap = parseInt(capMatch[1], 10);
    const mk = new Function('CONTENT_CACHE_MAX',
        'let chatContentCache = {}; let contentCacheOrder = [];\n'
        + extract('touchContentCache')
        + '\nreturn { touch: touchContentCache, set: (k) => { chatContentCache[k] = [k]; touchContentCache(k); }, cache: () => chatContentCache, order: () => contentCacheOrder };');
    const c = mk(cap);
    for (let i = 0; i < cap + 6; i++) c.set('A.png::chat' + i);
    assert(Object.keys(c.cache()).length === cap, `cache bounded at ${cap} after ${cap + 6} inserts`);
    assert(!c.cache()['A.png::chat0'] && !!c.cache()['A.png::chat' + (cap + 5)], 'oldest evicted, newest kept');
    // touch-refresh: oldest surviving key touched, then one more insert evicts the SECOND-oldest instead
    const survivors = c.order().slice();
    c.touch(survivors[0]);
    c.set('A.png::fresh');
    assert(!!c.cache()[survivors[0]] && !c.cache()[survivors[1]], 'touched entry survives; untouched next-oldest evicted');
}

console.log('[15] Pin scoping: per-character isolation with legacy migration');
{
    const shared = { pinned: { 'New Chat.jsonl': true } }; // legacy global pin
    let charKey = 'A.png';
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'saveSettings', 'scheduleSync',
        extract('pinKey') + '\n' + extract('isPinnedFile') + '\n' + extract('togglePin')
        + '\nreturn { pinKey, isPinnedFile, togglePin };');
    const api15 = mk(() => shared, () => charKey, () => {}, () => {});
    assert(api15.isPinnedFile('New Chat.jsonl') === true, 'legacy bare-key pin honored on read');
    api15.togglePin('New Chat.jsonl'); // unpin: migrates legacy away
    assert(!shared.pinned['New Chat.jsonl'] && !shared.pinned['A.png::New Chat.jsonl'], 'toggle migrates legacy key away');
    api15.togglePin('New Chat.jsonl'); // pin again -> scoped
    assert(shared.pinned['A.png::New Chat.jsonl'] === true, 'repin writes character-scoped key');
    charKey = 'B.png';
    assert(api15.isPinnedFile('New Chat.jsonl') === false, 'same filename NOT pinned on another character');
}

console.log('[16] Group preview fetches THIS entry, not the open chat');
{
    const fcm = stripComments(extract('fetchChatMessages'));
    assert(/isGroup\s*\n?\s*\?\s*\{\s*id:\s*fileName\.replace/.test(fcm), 'group body id derived from fileName');
    assert(!/id:\s*context\.groupId/.test(fcm), 'old wrong-file body gone');
    assert(fcm.includes('contentCacheKey(fileName)'), 'cache reads/writes use character-scoped key');
}

console.log('[17] escAttr: selector-safe filenames');
{
    const esc = new Function(extract('escAttr') + '\nreturn escAttr;')();
    assert(esc('a"b\\c') === 'a\\"b\\\\c', 'quotes and backslashes escaped');
    assert(esc('plain name.jsonl') === 'plain name.jsonl', 'plain names untouched');
    assert(stripComments(extract('findNativeBlock')).includes('escAttr(fileName)'), 'native block lookup routed through escAttr');
}

console.log('[18] Bulk delete: group branch wired through ST group-chats module');
{
    const ub = stripComments(extract('updateBulkBar'));
    assert(ub.includes("import('/scripts/group-chats.js')") && ub.includes('deleteGroupChatByName(groupId'), 'group path uses deleteGroupChatByName');
    assert(ub.includes('!groupId && (characterId === undefined'), 'character-missing error only fires OUTSIDE groups');
}

console.log('[19] refreshActivityData: stale ranks dropped synchronously on character switch');
{
    let fetchCalls = 0;
    const pendingFetch = () => { fetchCalls++; return new Promise(() => {}); }; // never resolves
    const ttl = parseInt(src.match(/const ACTIVITY_TTL_MS = (\d+);/)[1], 10);
    const mk = new Function('getCurrentCharacterId', 'buildActivityData', 'scheduleSync', 'fetch', 'SillyTavern', 'ACTIVITY_TTL_MS', 'initial', 'console',
        'let activityData = initial;\n' + 'async ' + extract('refreshActivityData')
        + '\nreturn { run: refreshActivityData, get: () => activityData };');
    const a = mk(() => 'B.png', () => ({ rank: {}, branchOf: {} }), () => {}, pendingFetch,
        { getContext: () => ({ getRequestHeaders: () => ({}) }) }, ttl,
        { charKey: 'A.png', fetchedAt: Date.now(), rank: { 'Old': 0 }, branchOf: { 'Old': 'P' } }, console);
    a.run(); // char switched A -> B; fetch left pending on purpose
    assert(a.get().charKey === 'B.png' && Object.keys(a.get().rank).length === 0, 'previous character ranks dropped before fetch resolves');
    assert(fetchCalls === 1, 'fetch dispatched once');
    a.run(); // same char, within TTL, not forced
    assert(fetchCalls === 1, 'TTL gate suppresses duplicate fetch');
}

console.log('[20] Search render fan-out capped');
{
    assert(/searchTerm\s*\n?\s*\?\s*Math\.min\(/.test(extract('performSync')), 'initial search render capped via Math.min (sentinel lazy-loads rest)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
