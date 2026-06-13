const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const statusNotOk = false;
const statusOk = true;

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'gameState.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------- 牌池常量 ----------------
const OMEN_POOL = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const JOKER_POOL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function buildRoomPool(exp) {
    let baseSet = new Set();
    for (let i = 10; i <= 31; i++) baseSet.add(i);
    for (let i = 16; i <= 27; i++) baseSet.add(i);
    for (let i = 32; i <= 42; i++) baseSet.add(i);
    for (let i = 1; i <= 17; i++) baseSet.add(i);
    for (let i = 32; i <= 33; i++) baseSet.add(i);
    if (exp === 'bloodmoon') { baseSet.add(43); baseSet.add(44); }
    else if (exp === 'xmas') { baseSet.add(45); baseSet.add(46); }
    else if (exp === 'joker') { baseSet.add(47); baseSet.add(48); baseSet.add(49); baseSet.add(50); }
    return Array.from(baseSet).sort((a, b) => a - b);
}
function getItemPool(exp) {
    let base = Array.from({ length: 24 }, (_, i) => i + 1);
    if (exp === 'bloodmoon') base.push(25, 26);
    else if (exp === 'xmas') base.push(27, 28);
    return base;
}
function getEventPool(exp) {
    let base = Array.from({ length: 43 }, (_, i) => i + 1);
    if (exp === 'bloodmoon') base.push(44, 45);
    else if (exp === 'xmas') base.push(46, 47);
    return base;
}

// ---------------- 牌库操作 (基于纯对象, 可JSON序列化) ----------------
function shuffleArr(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}
function makeDeck(cards) {
    const remaining = [...cards];
    shuffleArr(remaining);
    return { allPossible: [...cards], remaining, drawn: [], buriedQueue: [], operationHistory: [] };
}
function ensureRemaining(deck) {
    if (deck.remaining.length === 0 && deck.buriedQueue.length > 0) {
        deck.remaining = [...deck.buriedQueue];
        deck.buriedQueue = [];
    }
}
function deckGetAvailable(deck) {
    ensureRemaining(deck);
    return [...deck.remaining];
}
function deckDraw(deck) {
    ensureRemaining(deck);
    if (deck.remaining.length === 0) return null;
    const idx = 0;
    const card = deck.remaining[idx];
    deck.remaining.splice(idx, 1);
    deck.drawn.push(card);
    deck.operationHistory.push({ type: 'draw', value: card });
    return card;
}
function deckDrawFromList(deck, candidates) {
    if (!candidates || candidates.length === 0) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const idx = deck.remaining.indexOf(pick);
    if (idx !== -1) deck.remaining.splice(idx, 1);
    deck.drawn.push(pick);
    deck.operationHistory.push({ type: 'draw', value: pick });
    return pick;
}
function deckBuryCard(deck, value) {
    const idx = deck.drawn.indexOf(value);
    if (idx !== -1) {
        deck.drawn.splice(idx, 1);
        deck.buriedQueue.push(value);
        deck.operationHistory.push({ type: 'bury', value });
        return true;
    }
    return false;
}
function deckReshuffleCard(deck, value) {
    const idx = deck.drawn.indexOf(value);
    if (idx !== -1) {
        deck.drawn.splice(idx, 1);
        deck.remaining.push(value);
        shuffleArr(deck.remaining);
        return true;
    }
    return false;
}
function deckUndo(deck) {
    if (deck.operationHistory.length === 0) return null;
    const lastOp = deck.operationHistory.pop();
    if (lastOp.type === 'draw') {
        const card = lastOp.value;
        const idx = deck.drawn.lastIndexOf(card);
        if (idx !== -1) deck.drawn.splice(idx, 1);
        deck.remaining.push(card);
        return { type: 'draw', value: card };
    } else if (lastOp.type === 'bury') {
        const card = lastOp.value;
        const idx = deck.buriedQueue.lastIndexOf(card);
        if (idx !== -1) deck.buriedQueue.splice(idx, 1);
        deck.drawn.push(card);
        return { type: 'bury', value: card };
    }
    return null;
}
function deckGetDrawnOrder(deck, recentFirst = true) {
    const copy = [...deck.drawn];
    return recentFirst ? copy.reverse() : copy;
}
function deckRemoveCards(deck, cardsToRemove) {
    for (let card of cardsToRemove) {
        let idx = deck.remaining.indexOf(card);
        if (idx !== -1) deck.remaining.splice(idx, 1);
        idx = deck.drawn.indexOf(card);
        if (idx !== -1) deck.drawn.splice(idx, 1);
        idx = deck.buriedQueue.indexOf(card);
        if (idx !== -1) deck.buriedQueue.splice(idx, 1);
        idx = deck.allPossible.indexOf(card);
        if (idx !== -1) deck.allPossible.splice(idx, 1);
    }
}

// 房间楼层可用范围
function getFloorAvailable(state, floor) {
    const exp = state.currentExp;
    let allowed = new Set();
    if (floor === '2') for (let i = 10; i <= 31; i++) allowed.add(i);
    else if (floor === '1') { for (let i = 16; i <= 27; i++) allowed.add(i); for (let i = 32; i <= 42; i++) allowed.add(i); }
    else if (floor === '0') { for (let i = 1; i <= 17; i++) allowed.add(i); for (let i = 32; i <= 33; i++) allowed.add(i); }
    if (exp === 'bloodmoon') { if (floor === '1') allowed.add(44); if (floor === '0') allowed.add(43); }
    else if (exp === 'xmas') { if (floor === '2') allowed.add(46); if (floor === '0') allowed.add(45); }
    else if (exp === 'joker') {
        if (floor === '2') allowed.add(50);
        if (floor === '1') allowed.add(50);
        if (floor === '0') for (let i = 47; i <= 50; i++) allowed.add(i);
    }
    const remainSet = new Set(deckGetAvailable(state.decks.room));
    return Array.from(allowed).filter(n => remainSet.has(n));
}

// ---------------- 状态管理 ----------------
function defaultState() {
    const state = {
        gameStarted: false,
        currentExp: 'none',
        decks: {
            room: makeDeck(buildRoomPool('')),
            omen: makeDeck([...OMEN_POOL]),
            item: makeDeck(getItemPool('')),
            event: makeDeck(getEventPool('')),
            joker: makeDeck([...JOKER_POOL]),
        },
        results: { room: '⚡ 等待探索', event: '-', omen: '-', item: '-', joker: '-' },
        diceCount: 3,
        diceSum: 0,
        diceVisuals: [1, 1, 1],
        log: [],
    };
    addLog(state, '🎮 程序已启动，请选择拓展包并点击"确认开局"');
    return state;
}

function addLog(state, msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    state.log.unshift(`[${time}] ${msg}`);
    if (state.log.length > 45) state.log.pop();
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('读取状态文件失败，使用默认状态', e);
    }
    return defaultState();
}

let state = loadState();

let saveTimer = null;
function saveState() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
            if (err) console.error('保存状态文件失败', err);
        });
    }, 50);
}
saveState();

// 洗牌函数（Fisher–Yates）
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 重置所有牌库（确认开局 / 进行下局游戏）
function resetAllDecks(state) {
  const exp = state.currentExp === 'none' ? '' : state.currentExp;

  // 构建房间牌库 -> 洗牌
  state.decks.room = shuffleDeck(makeDeck(buildRoomPool(exp)));

  // 预兆牌库（固定卡池） -> 洗牌
  state.decks.omen = shuffleDeck(makeDeck([...OMEN_POOL]));

  // 物品牌库 -> 洗牌
  state.decks.item = shuffleDeck(makeDeck(getItemPool(exp)));

  // 事件牌库需要特殊处理：先移除拓展规定的牌，再洗牌
  state.decks.event = makeDeck(getEventPool(exp));
  if (state.currentExp === 'joker') {
    deckRemoveCards(state.decks.event, [1, 29]);
    addLog(state, '🎭 小丑回魂拓展生效：事件牌库已移除数字1和29');
  }
  state.decks.event = shuffleDeck(state.decks.event);

  // 小丑牌库（仅小丑拓展会有用） -> 洗牌
  state.decks.joker = shuffleDeck(makeDeck([...JOKER_POOL]));

  // 重置结果面板
  state.results = { room: '⚡ 等待探索', event: '-', omen: '-', item: '-', joker: '-' };
  addLog(state, `🔄 重置所有牌库 | 拓展:${state.currentExp === 'none' ? '本体' : state.currentExp}`);
}

// 重置所有牌库 (确认开局 / 进行下局游戏)
// function resetAllDecks(state) {
//     const exp = state.currentExp === 'none' ? '' : state.currentExp;
//     state.decks.room = makeDeck(buildRoomPool(exp));
//     state.decks.omen = makeDeck([...OMEN_POOL]);
//     state.decks.item = makeDeck(getItemPool(exp));
//     state.decks.event = makeDeck(getEventPool(exp));
//     state.decks.joker = makeDeck([...JOKER_POOL]);

//     if (state.currentExp === 'joker') {
//         deckRemoveCards(state.decks.event, [1, 29]);
//         addLog(state, '🎭 小丑回魂拓展生效：事件牌库已移除数字1和29');
//     }

//     state.results = { room: '⚡ 等待探索', event: '-', omen: '-', item: '-', joker: '-' };
//     addLog(state, `🔄 重置所有牌库 | 拓展:${state.currentExp === 'none' ? '本体' : state.currentExp}`);
// }

const DECK_NAMES = { room: '房间', event: '事件', omen: '预兆', item: '物品', joker: '小丑遭遇' };
const DECK_ICONS = { room: '🏚️', event: '🎉', omen: '🔮', item: '🎁', joker: '🎭' };

// ---------------- 路由处理 ----------------
const routes = {
    'GET /api/state': (req, res, body) => {
        sendJSON(res, 200, { ok: statusOk, state: state });
    },
    'POST /api/expansion': (req, res, body) => {
        if (state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '游戏已开局，如需重新开始请进行下局游戏' });
        const val = body.value;
        if (!['none', 'bloodmoon', 'xmas', 'joker'].includes(val)) return sendJSON(res, 200, { ok: statusNotOk, error: '非法拓展包' });
        state.currentExp = val;
        const exp = val === 'none' ? '' : val;
        state.decks.room = makeDeck(buildRoomPool(exp));
        state.decks.omen = makeDeck([...OMEN_POOL]);
        state.decks.item = makeDeck(getItemPool(exp));
        state.decks.event = makeDeck(getEventPool(exp));
        state.decks.joker = makeDeck([...JOKER_POOL]);
        if (val === 'joker') deckRemoveCards(state.decks.event, [1, 29]);
        addLog(state, `📦 预选拓展包: ${val === 'none' ? '本体' : val}，请确认开局`);
        saveState();
        sendJSON(res, 200, { ok: statusOk, state: state });
    },
    'POST /api/confirm': (req, res, body) => {
        if (state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '游戏已开局' });
        resetAllDecks(state);
        state.gameStarted = true;
        addLog(state, `✅ 确认开局，拓展包: ${state.currentExp === 'none' ? '无拓展包(本体)' : state.currentExp}`);
        saveState();
        sendJSON(res, 200, { ok: statusOk, state: state });
    },
    'POST /api/draw': (req, res, body) => {
        if (!state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '请先点击"确认开局"' });
        const deckName = body.deck;
        const floor = body.floor;
        const deck = state.decks[deckName];
        if (!deck) return sendJSON(res, 200, { ok: statusNotOk, error: '未知牌库' });

        let result;
        if (deckName === 'room' && floor !== undefined) {
            // console.log(deckName, floor)
            let candidates;
            if (floor === 'any') candidates = deckGetAvailable(deck);
            else candidates = getFloorAvailable(state, floor);
            if (candidates.length === 0) {
                result = '无可用卡牌！'
            } else {
                result = deckDrawFromList(deck, candidates);
            }
            state.results.room = `${result}`;
            addLog(state, `🎴 房间 第${floor}层 → ${result}`);
        } else {
            if (deckGetAvailable(deck).length === 0) {
                result = '牌库已空'
            } else {
                result = deckDraw(deck);
            }
            state.results[deckName] = `${result}`;
            addLog(state, `🎴 ${DECK_NAMES[deckName]} → ${result}`);
        }
        saveState();
        sendJSON(res, 200, { ok: statusOk, state: state });// todo
    },
    'POST /api/bury': (req, res, body) => {
        if (!state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '请先点击"确认开局"' });
        const { deck: deckName, value } = body;
        const deck = state.decks[deckName];
        if (!deck) return sendJSON(res, 200, { ok: statusNotOk, error: '未知牌库' });
        const ok = deckBuryCard(deck, value);
        if (!ok) return sendJSON(res, 200, { ok: statusNotOk, error: '操作失败' });
        addLog(state, `⚰️ 埋葬 ${DECK_NAMES[deckName]} ${value}`);
        if (deckName === 'room') state.results.room = '牌库已更新';
        else state.results[deckName] = '-';
        saveState();
        sendJSON(res, 200, {ok: statusOk});
    },
    'POST /api/reshuffle': (req, res, body) => {
        if (!state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '请先点击"确认开局"' });
        const { deck: deckName, value } = body;
        const deck = state.decks[deckName];
        if (!deck) return sendJSON(res, 200, { ok: statusNotOk, error: '未知牌库' });
        const ok = deckReshuffleCard(deck, value);
        if (!ok) return sendJSON(res, 200, { ok: statusNotOk, error: '操作失败' });
        addLog(state, `🔄 洗回牌堆 ${DECK_NAMES[deckName]} ${value}`);
        if (deckName === 'room') state.results.room = '牌库已更新';
        else state.results[deckName] = '-';
        saveState();
        sendJSON(res, 200, { ok: statusOk, state: state });
    },
    'POST /api/undo': (req, res, body) => {
        if (!state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '请先点击"确认开局"' });
        const { deck: deckName } = body;
        const deck = state.decks[deckName];
        if (!deck) return sendJSON(res, 200, { ok: statusNotOk, error: '未知牌库' });
        const undoResult = deckUndo(deck);
        if (!undoResult) return sendJSON(res, 200, { ok: statusNotOk, error: '无操作可撤回' });
        const { type, value } = undoResult;
        const name = DECK_NAMES[deckName];
        let msg = '';
        if (type === 'draw') msg = `已撤回：抽取${name} ${value}`;
        else if (type === 'bury') msg = `已撤回：埋葬${name} ${value}`;
        addLog(state, `↩️ ${msg}`);
        saveState();
        sendJSON(res, 200, { ok: statusOk, message: msg });
    },
    'POST /api/dice': (req, res, body) => {
        if (!state.gameStarted) return sendJSON(res, 200, { ok: statusNotOk, error: '请先点击"确认开局"' });
        let count = parseInt(body.count);
        if (isNaN(count)) count = 3;
        if (count > 8) count = 8;
        if (count < 1) count = 1;
        const results = [];
        let sum = 0;
        for (let i = 0; i < count; i++) {
            const v = Math.floor(Math.random() * 3);
            results.push(v);
            sum += v;
        }
        state.diceCount = count;
        state.diceVisuals = results;
        state.diceSum = sum;
        addLog(state, `🎲 投掷${count}颗骰子，结果：${results}，总和${sum}。`);
        saveState();
        sendJSON(res, 200, { ok: statusOk});
    },
    'POST /api/dice-count': (req, res, body) => {
        let count = parseInt(body.count);
        if (isNaN(count)) count = 3;
        if (count > 8) count = 8;
        if (count < 1) count = 1;
        state.diceCount = count;
        saveState();
        sendJSON(res, 200, { ok: statusOk, state });
    },
    'POST /api/reset': (req, res, body) => {
        state = defaultState();
        addLog(state, '🔄 已重新开始新的一局，请选择拓展包并确认开局');
        saveState();
        sendJSON(res, 200, { ok: statusOk, state: state });
    },
};

function sendJSON(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403); return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Not Found');
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // 动态路由: /api/drawn/:deck
    if (req.method === 'GET' && pathname.startsWith('/api/drawn/')) {
        const deckName = pathname.split('/').pop();
        const deck = state.decks[deckName];
        if (!deck) return sendJSON(res, 200, { ok: statusNotOk, error: '未知牌库' });
        return sendJSON(res, 200, { ok: statusOk, drawn: deckGetDrawnOrder(deck, true) });
    }

    const routeKey = `${req.method} ${pathname}`;
    if (routes[routeKey]) {
        if (req.method === 'POST') {
            let bodyData = '';
            req.on('data', chunk => bodyData += chunk);
            req.on('end', () => {
                let parsedBody = {};
                try { parsedBody = bodyData ? JSON.parse(bodyData) : {}; } catch (e) { }
                try {
                    routes[routeKey](req, res, parsedBody);
                } catch (e) {
                    console.error(e);
                    sendJSON(res, 500, { error: '服务器内部错误' });
                }
            });
        } else {
            routes[routeKey](req, res, {});
        }
        return;
    }

    if (req.method === 'GET') {
        return serveStatic(req, res, pathname);
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`山中小屋3 服务已启动: http://localhost:${PORT}`);
    console.log(`状态文件: ${STATE_FILE}`);
});