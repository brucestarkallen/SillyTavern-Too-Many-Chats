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


console.log('[8] buildActivityData: branch parentage extraction + character filtering');
{
    const build = new Function(extract('buildActivityData') + '\nreturn buildActivityData;')();
    const items = [
        { file_id: 'Branch #1 - Old', avatar: 'A.png', chat_metadata: { main_chat: 'Old' } },
        { file_id: 'Fresh', avatar: 'A.png' },
        { file_id: 'OtherBranch', avatar: 'B.png', chat_metadata: { main_chat: 'Elsewhere' } },
        { file_id: 'GB', group: 1720000000, chat_metadata: { main_chat: 'GroupParent' } },
        { file_id: 'Old', avatar: 'A.png', chat_metadata: {} },
        { file_id: 'RootStray', chat_metadata: { main_chat: 'X' } },
        null,
        { file_id: 42, avatar: 'A.png' },
    ];
    const a = build(items, 'A.png');
    assert(JSON.stringify(a.branchOf) === JSON.stringify({ 'Branch #1 - Old': 'Old' }),
        'only current character branches captured: ' + JSON.stringify(a.branchOf));
    assert(!('rank' in a), 'rank machinery gone from builder');
    const g = build(items, 1720000000);
    assert(g.branchOf['GB'] === 'GroupParent', 'numeric group id matches via String coercion');
    assert(JSON.stringify(build(undefined, 'A.png')) === JSON.stringify({ branchOf: {} }), 'non-array input safe');
}

console.log('[9] sortChats: last-active = max(stamp, last-msg) — THE branch scenario');
{
    let charKey = 'A.png';
    const shared = { lastActive: { 'A.png::Branch #1 - Old': 5000 } };
    const mkSort = new Function('sortOrder', 'getSettings', 'getCurrentCharacterId',
        extract('lastActiveKey') + '\n' + extract('getLastActive') + '\n' + extract('sortChats') + '\nreturn sortChats;');
    const chats = [
        { fileName: 'Ancient.jsonl', metadata: { name: 'ancient', date: 100, msgCount: 0, size: 0 } },
        { fileName: 'Fresh.jsonl', metadata: { name: 'fresh', date: 3000, msgCount: 0, size: 0 } },
        { fileName: 'Branch #1 - Old.jsonl', metadata: { name: 'branch #1 - old', date: 990, msgCount: 0, size: 0 } },
        { fileName: 'Old.jsonl', metadata: { name: 'old', date: 1000, msgCount: 0, size: 0 } },
    ];
    let out = mkSort('activity-desc', () => shared, () => charKey)([...chats]).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Branch #1 - Old.jsonl', 'Fresh.jsonl', 'Old.jsonl', 'Ancient.jsonl']),
        'stamped branch with OLD last-msg date sorts FIRST; unstamped by last-msg: ' + JSON.stringify(out));
    // no stamps at all -> reduces to pure last-message ordering
    out = mkSort('activity-desc', () => ({ lastActive: {} }), () => charKey)([...chats]).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Fresh.jsonl', 'Old.jsonl', 'Branch #1 - Old.jsonl', 'Ancient.jsonl']),
        'unstamped library degrades to last-message desc (branch sinks: the pre-fix behavior)');
    // max() semantics: an old stamp does NOT beat a newer message elsewhere
    out = mkSort('activity-desc', () => ({ lastActive: { 'A.png::Old': 2000 } }), () => charKey)([...chats]).map(c => c.fileName);
    assert(out[0] === 'Fresh.jsonl' && out[1] === 'Old.jsonl', 'stamp is a floor, not a tier: newer last-msg still wins');
    // character isolation
    charKey = 'B.png';
    out = mkSort('activity-desc', () => shared, () => charKey)([...chats]).map(c => c.fileName);
    assert(out[0] === 'Fresh.jsonl', 'stamps from another character ignored');
    charKey = 'A.png';
    out = mkSort('name-asc', () => shared, () => charKey)([...chats]).map(c => c.fileName);
    assert(out[0] === 'Ancient.jsonl', 'regression: name-asc unaffected by stamps');
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

console.log('[19] refreshActivityData: stale branch map dropped on switch; small fetch window');
{
    let fetchCalls = 0; let lastBody = null;
    const pendingFetch = (url, opts) => { fetchCalls++; lastBody = opts.body; return new Promise(() => {}); };
    const ttl = parseInt(src.match(/const ACTIVITY_TTL_MS = (\d+);/)[1], 10);
    const bmax = parseInt(src.match(/const BRANCH_FETCH_MAX = (\d+);/)[1], 10);
    assert(bmax <= 100, `branch fetch window small (${bmax}) — endpoint only line-streams top-N, so cost stays bounded`);
    const mk = new Function('getCurrentCharacterId', 'buildActivityData', 'scheduleSync', 'fetch', 'SillyTavern', 'ACTIVITY_TTL_MS', 'BRANCH_FETCH_MAX', 'initial', 'console',
        'let activityData = initial;\n' + 'async ' + extract('refreshActivityData')
        + '\nreturn { run: refreshActivityData, get: () => activityData };');
    const a = mk(() => 'B.png', () => ({ branchOf: {} }), () => {}, pendingFetch,
        { getContext: () => ({ getRequestHeaders: () => ({}) }) }, ttl, bmax,
        { charKey: 'A.png', fetchedAt: Date.now(), branchOf: { 'Old': 'P' } }, console);
    a.run(); // char switched A -> B; fetch left pending on purpose
    assert(a.get().charKey === 'B.png' && Object.keys(a.get().branchOf).length === 0, 'previous character branch map dropped before fetch resolves');
    assert(fetchCalls === 1 && JSON.parse(lastBody).max === bmax && JSON.parse(lastBody).metadata === true, 'one fetch, bounded max, metadata on');
    a.run(); // same char, within TTL, not forced
    assert(fetchCalls === 1, 'TTL gate suppresses duplicate fetch');
}

console.log('[20] Search render fan-out capped');
{
    assert(/searchTerm\s*\n?\s*\?\s*Math\.min\(/.test(extract('performSync')), 'initial search render capped via Math.min (sentinel lazy-loads rest)');
}


console.log('[21] Activity stamping: write, scope, prune');
{
    const shared2 = { lastActive: {} };
    let saves = 0; let charKey2 = 'A.png'; let activeChat = 'My Branch';
    const capHard = parseInt(src.match(/const LAST_ACTIVE_HARD_CAP = (\d+);/)[1], 10);
    const capKeep = parseInt(src.match(/const LAST_ACTIVE_KEEP = (\d+);/)[1], 10);
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'getActiveChatName', 'saveSettings', 'LAST_ACTIVE_HARD_CAP', 'LAST_ACTIVE_KEEP',
        extract('lastActiveKey') + '\n' + extract('stampActivity') + '\n' + extract('getLastActive') + '\n' + extract('pruneLastActive')
        + '\nreturn { stamp: stampActivity, get: getLastActive, prune: pruneLastActive };');
    const api21 = mk(() => shared2, () => charKey2, () => activeChat, () => saves++, capHard, capKeep);
    api21.stamp();
    assert(api21.get('My Branch.jsonl') > 0 && saves === 1, 'stamp written under scoped key, settings saved');
    charKey2 = 'B.png';
    assert(api21.get('My Branch.jsonl') === 0, 'stamp invisible from another character');
    charKey2 = 'A.png'; activeChat = null;
    api21.stamp();
    assert(saves === 1, 'no active chat -> no write, no save');
    // prune: overfill past hard cap, oldest dropped, newest kept
    const m = {};
    for (let i = 1; i <= capHard + 1; i++) m['A.png::c' + i] = i;
    api21.prune(m);
    assert(Object.keys(m).length === capKeep, `pruned to ${capKeep}`);
    assert(!m['A.png::c1'] && !!m['A.png::c' + (capHard + 1)], 'oldest evicted, newest kept');
}

console.log('[22] getBranchParent: metadata first, filename-pattern fallback');
{
    const mk = new Function('activityData', extract('getBranchParent') + '\nreturn getBranchParent;');
    const getBP = mk({ branchOf: { 'Meta Chat': 'Real Parent', 'Named - Branch #9': 'Metadata Wins' } });
    assert(getBP('Meta Chat.jsonl') === 'Real Parent', 'metadata hit');
    assert(getBP('Named - Branch #9.jsonl') === 'Metadata Wins', 'metadata takes precedence over pattern');
    assert(getBP('Epic Story - Branch #3.jsonl') === 'Epic Story', 'modern naming fallback');
    assert(getBP('Branch #2 - Old Tale') === 'Old Tale', 'legacy naming fallback');
    assert(getBP('Just A Chat.jsonl') === null, 'plain chats untouched');
}


console.log('[23] resolveFamilyRoot: transitive climb, cycle guard, extension handling');
{
    const chains = { 'C': 'B', 'B': 'A' };
    const mk = new Function('getBranchParent', extract('resolveFamilyRoot') + '\nreturn resolveFamilyRoot;');
    const resolve = mk((id) => chains[String(id).replace(/\.jsonl$/i, '')] || null);
    assert(resolve('C.jsonl') === 'A', 'branch-of-a-branch climbs to root (C -> B -> A)');
    assert(resolve('A') === 'A', 'root resolves to itself');
    const cyc = mk((id) => ({ 'A': 'B', 'B': 'A' }[id] || null));
    const r = cyc('A');
    assert(r === 'A' || r === 'B', 'parentage cycle terminates deterministically without throwing');
}

console.log('[24] familyClusters: lineage sections, orphan branches, singles');
{
    const clusters = new Function(extract('familyClusters') + '\nreturn familyClusters;')();
    const resolver = (id) => {
        const m = id.match(/^(.*) - Branch #\d+$/) || id.match(/^Branch #\d+ - (.*)$/);
        return m ? m[1] : id;
    };
    const out = clusters(['Branch #2 - Saga', 'Solo', 'Saga', 'Lost Tale - Branch #1'], resolver);
    assert(JSON.stringify(out.order) === JSON.stringify(['Saga', 'Lost Tale']),
        'family order follows first appearance (= most recently active member): ' + JSON.stringify(out.order));
    assert(JSON.stringify(out.members['Saga']) === JSON.stringify(['Branch #2 - Saga', 'Saga']),
        'parent and branches share one section, input order preserved');
    assert(JSON.stringify(out.members['Lost Tale']) === JSON.stringify(['Lost Tale - Branch #1']),
        'orphan branch (parent deleted) still forms a family under the lineage name');
    assert(JSON.stringify(out.singles) === JSON.stringify(['Solo']), 'non-branch chats without branches stay single');
    assert(JSON.stringify(clusters([], resolver)) === JSON.stringify({ order: [], members: {}, singles: [] }), 'empty input safe');
}

console.log('[25] Family view wiring: static structure of the real file');
{
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('familyClusters(') && ps.includes("'family::' + root"), 'performSync builds family sections from sorted order');
    assert(ps.includes("createUncategorizedDOM('Other chats')"), 'non-family chats routed to Other chats in family mode');
    assert(ps.includes('familyFidByChat[chatId]'), 'distribution loop routes through the family map');
    const rb = stripComments(extract('renderBatch'));
    assert(rb.includes("!isFamily") && rb.includes("|| isFamily)"), 'families exempt from 3-item truncation, included in sentinel lazy-load');
    assert(rb.includes('escAttr(folderId)'), 'section lookup selector escaped (family ids contain arbitrary chat names)');
    const ib = stripComments(extract('injectAddButton'));
    assert(ib.includes('s.familyView = !s.familyView') && ib.includes('saveSettings()'), 'toggle persists');
    assert(src.includes('familyView: false') && src.includes('familyCollapsed: {}'), 'settings schema carries family keys');
    assert(stripComments(extract('createFamilyDOM')).includes('familyCollapseKey(root)'), 'collapse state character-scoped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
