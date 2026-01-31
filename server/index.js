const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/cards', express.static(path.join(__dirname, '../cards')));

// Game state - stored in memory
const rooms = new Map();
const players = new Map(); // playerId -> { roomCode, name, ... }

// Online stats
let onlineStats = {
  waiting: 0,    // In lobby, not started
  playing: 0,    // In active game
  total: 0
};

// Page viewers tracking
const pageViewers = new Map(); // viewerId -> lastSeen timestamp
const VIEWER_TIMEOUT = 15000; // 15 seconds

function cleanupViewers() {
  const now = Date.now();
  for (const [id, lastSeen] of pageViewers) {
    if (now - lastSeen > VIEWER_TIMEOUT) {
      pageViewers.delete(id);
    }
  }
}

function updateOnlineStats() {
  let waiting = 0;
  let playing = 0;
  
  for (const [code, room] of rooms) {
    const humanPlayers = room.players.filter(p => !p.isBot).length;
    if (room.phase === 'waiting') {
      waiting += humanPlayers;
    } else {
      playing += humanPlayers;
    }
  }
  
  onlineStats = { waiting, playing, total: waiting + playing };
}

// Generate room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Generate player ID
function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substr(2, 9);
}

// Bot names - Lobster/Seafood themed for Moltbook!
const botNames = [
  '螃蟹', '蝦蝦', '章魚', '水母', '海星', '貝殼',
  '鯨魚', '海豚', '海龜', '河豚', '小丑魚', '海馬',
  '珊瑚', '海草', '魷魚', '鮪魚', '鯊鯊', '螺螺',
  '蛤蜊', '淡菜', '扇貝', '海膽', '海參', '龍蝦王'
];

// Story hints for bot storyteller
const botStoryHints = [
  '夢境', '回憶', '冒險', '秘密', '遠方', '童年',
  '月光', '迷路', '寶藏', '魔法', '星空', '森林',
  '海洋', '飛翔', '時間', '友誼', '勇氣', '希望',
  '神秘', '奇蹟', '孤獨', '溫暖', '告別', '重逢'
];

// Bot AI: Execute bot actions for a room
function processBotActions(room) {
  const storyteller = room.players[room.storytellerIndex];
  
  if (room.phase === 'storytelling' && storyteller?.isBot) {
    // Bot is storyteller - pick random card and story
    setTimeout(() => {
      if (room.phase !== 'storytelling') return;
      
      const card = storyteller.hand[Math.floor(Math.random() * storyteller.hand.length)];
      const story = botStoryHints[Math.floor(Math.random() * botStoryHints.length)];
      
      storyteller.hand = storyteller.hand.filter(c => c.id !== card.id);
      room.story = story;
      room.storytellerCard = card.id;
      room.phase = 'selecting';
      room.submittedCards = [{ playerId: storyteller.id, card }];
      room.lastUpdate = Date.now();
      
      console.log(`[${room.code}] 🤖 ${storyteller.name} 說了故事: "${story}"`);
      
      // Trigger bot card selection
      setTimeout(() => processBotActions(room), 1000);
    }, 1500 + Math.random() * 1000);
  }
  
  if (room.phase === 'selecting') {
    // Bots select cards
    const botsToSelect = room.players.filter(p => 
      p.isBot && 
      p.id !== storyteller?.id && 
      !room.submittedCards.find(s => s.playerId === p.id)
    );
    
    botsToSelect.forEach((bot, index) => {
      setTimeout(() => {
        if (room.phase !== 'selecting') return;
        if (room.submittedCards.find(s => s.playerId === bot.id)) return;
        
        const card = bot.hand[Math.floor(Math.random() * bot.hand.length)];
        bot.hand = bot.hand.filter(c => c.id !== card.id);
        room.submittedCards.push({ playerId: bot.id, card });
        room.lastUpdate = Date.now();
        
        console.log(`[${room.code}] 🤖 ${bot.name} 選了牌 (${room.submittedCards.length}/${room.players.length})`);
        
        // Check if all submitted
        if (room.submittedCards.length === room.players.length) {
          room.submittedCards = shuffle(room.submittedCards);
          room.submittedCards.forEach((s, i) => s.displayNumber = i + 1);
          room.phase = 'voting';
          room.votes = {};
          console.log(`[${room.code}] 所有人都選牌了，進入投票階段`);
          
          // Trigger bot voting
          setTimeout(() => processBotActions(room), 1000);
        }
      }, 1000 + index * 800 + Math.random() * 500);
    });
  }
  
  if (room.phase === 'voting') {
    // Bots vote
    const botsToVote = room.players.filter(p => 
      p.isBot && 
      p.id !== storyteller?.id && 
      !room.votes[p.id]
    );
    
    botsToVote.forEach((bot, index) => {
      setTimeout(() => {
        if (room.phase !== 'voting') return;
        if (room.votes[bot.id]) return;
        
        // Find valid cards to vote for (not own card)
        const ownCard = room.submittedCards.find(s => s.playerId === bot.id);
        const validCards = room.submittedCards.filter(s => s.playerId !== bot.id);
        const chosenCard = validCards[Math.floor(Math.random() * validCards.length)];
        
        room.votes[bot.id] = chosenCard.displayNumber;
        room.lastUpdate = Date.now();
        
        console.log(`[${room.code}] 🤖 ${bot.name} 投給了 ${chosenCard.displayNumber} 號`);
        
        // Check if all voted
        if (Object.keys(room.votes).length === room.players.length - 1) {
          calculateScores(room);
        }
      }, 1200 + index * 600 + Math.random() * 400);
    });
  }
}

// Calculate scores (extracted for reuse)
function calculateScores(room) {
  const storyteller = room.players[room.storytellerIndex];
  const storytellerCard = room.submittedCards.find(s => s.playerId === storyteller.id);
  const votesForStoryteller = Object.values(room.votes).filter(v => v === storytellerCard.displayNumber).length;

  if (votesForStoryteller === 0 || votesForStoryteller === room.players.length - 1) {
    // All or none guessed - storyteller gets 0, others get 2
    room.players.forEach(p => {
      if (p.id !== storyteller.id) p.score += 2;
    });
  } else {
    // Some guessed correctly
    storyteller.score += 3;
    Object.entries(room.votes).forEach(([oderId, vote]) => {
      if (vote === storytellerCard.displayNumber) {
        const player = room.players.find(p => p.id === oderId);
        if (player) player.score += 3;
      }
    });
  }

  // Bonus points for misleading others
  room.submittedCards.forEach(s => {
    if (s.playerId !== storyteller.id) {
      const votesReceived = Object.values(room.votes).filter(v => v === s.displayNumber).length;
      const player = room.players.find(p => p.id === s.playerId);
      if (player) player.score += votesReceived;
    }
  });

  room.phase = 'reveal';
  room.lastUpdate = Date.now();
}

// Get card deck - use medium-sized images for better performance
function getCardDeck() {
  const cards = [];
  for (let i = 1; i <= 36; i++) {
    const num = i.toString().padStart(2, '0');
    cards.push({ 
      id: i, 
      image: `/cards/medium/card-${num}.png`,
      thumb: `/cards/thumb/card-${num}.png`,
      full: `/cards/card-${num}.png`
    });
  }
  return shuffle([...cards]);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// API Routes

// Viewer heartbeat - track page visitors
app.post('/api/viewer/heartbeat', (req, res) => {
  const { viewerId } = req.body;
  if (viewerId) {
    pageViewers.set(viewerId, Date.now());
  }
  cleanupViewers();
  res.json({ success: true, viewers: pageViewers.size });
});

// Get online stats
app.get('/api/stats', (req, res) => {
  updateOnlineStats();
  cleanupViewers();
  res.json({
    ...onlineStats,
    viewers: pageViewers.size  // People browsing the page
  });
});

// Get player type emoji
function getTypeEmoji(type) {
  switch(type) {
    case 'lobster': return '🦞';
    case 'bot': return '🤖';
    default: return '👤';
  }
}

// Create room
app.post('/api/room/create', (req, res) => {
  const { playerName, playerType } = req.body;
  if (!playerName) return res.status(400).json({ error: '請輸入暱稱' });

  const roomCode = generateRoomCode();
  const playerId = generatePlayerId();
  const deck = getCardDeck();
  const typeEmoji = getTypeEmoji(playerType);

  const player = {
    id: playerId,
    name: playerName,
    displayName: `${playerName}(${typeEmoji})`,
    type: playerType || 'human',
    hand: deck.splice(0, 6),
    score: 0,
    lastSeen: Date.now()
  };

  const room = {
    code: roomCode,
    host: playerId,
    players: [player],
    deck,
    phase: 'waiting',
    round: 0,
    storytellerIndex: 0,
    story: '',
    storytellerCard: null,
    submittedCards: [],
    votes: {},
    lastUpdate: Date.now()
  };

  rooms.set(roomCode, room);
  players.set(playerId, { roomCode, name: playerName });

  res.json({
    success: true,
    roomCode,
    playerId,
    player: { id: playerId, name: playerName, hand: player.hand, score: 0 },
    isHost: true
  });
});

// Join room
app.post('/api/room/join', (req, res) => {
  const { roomCode, playerName, playerType } = req.body;
  if (!playerName) return res.status(400).json({ error: '請輸入暱稱' });
  if (!roomCode) return res.status(400).json({ error: '請輸入房間代碼' });

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.phase !== 'waiting') return res.status(400).json({ error: '遊戲已經開始' });
  if (room.players.length >= 8) return res.status(400).json({ error: '房間已滿' });

  const playerId = generatePlayerId();
  const typeEmoji = getTypeEmoji(playerType);
  const player = {
    id: playerId,
    name: playerName,
    displayName: `${playerName}(${typeEmoji})`,
    type: playerType || 'human',
    hand: room.deck.splice(0, 6),
    score: 0,
    lastSeen: Date.now()
  };

  room.players.push(player);
  room.lastUpdate = Date.now();
  players.set(playerId, { roomCode: room.code, name: playerName });

  res.json({
    success: true,
    roomCode: room.code,
    playerId,
    player: { id: playerId, name: playerName, hand: player.hand, score: 0 },
    players: room.players.map(p => ({ id: p.id, name: p.displayName || p.name, score: p.score })),
    isHost: false
  });
});

// Rejoin room (after disconnect)
app.post('/api/room/rejoin', (req, res) => {
  const { playerId, roomCode } = req.body;
  if (!playerId || !roomCode) return res.status(400).json({ error: '缺少參數' });

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在或已過期' });

  const player = room.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: '找不到玩家資料' });

  player.lastSeen = Date.now();

  res.json({
    success: true,
    roomCode: room.code,
    playerId,
    player: { id: player.id, name: player.name, hand: player.hand, score: player.score },
    players: room.players.map(p => ({ id: p.id, name: p.displayName || p.name, score: p.score })),
    isHost: room.host === playerId,
    phase: room.phase,
    round: room.round,
    story: room.story,
    storytellerIndex: room.storytellerIndex,
    submittedCards: room.phase === 'voting' || room.phase === 'reveal' 
      ? room.submittedCards.map(s => ({ displayNumber: s.displayNumber, image: s.card.image }))
      : null
  });
});

// Poll room state (main polling endpoint)
app.get('/api/room/:roomCode/state', (req, res) => {
  const { roomCode } = req.params;
  const { playerId, since } = req.query;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });

  // Update player last seen
  const player = room.players.find(p => p.id === playerId);
  if (player) player.lastSeen = Date.now();

  // If no updates since last poll, return minimal response
  if (since && room.lastUpdate <= parseInt(since)) {
    return res.json({ noChange: true, lastUpdate: room.lastUpdate });
  }

  const storyteller = room.players[room.storytellerIndex];

  res.json({
    roomCode: room.code,
    phase: room.phase,
    round: room.round,
    players: room.players.map(p => ({ id: p.id, name: p.displayName || p.name, score: p.score })),
    storytellerId: storyteller?.id,
    storytellerName: storyteller?.displayName || storyteller?.name,
    story: room.story,
    isHost: room.host === playerId,
    hand: player?.hand || [],
    submittedCount: room.submittedCards.length,
    votedCount: Object.keys(room.votes).length,
    cards: (room.phase === 'voting' || room.phase === 'reveal')
      ? room.submittedCards.map(s => ({
          displayNumber: s.displayNumber,
          image: s.card.image,
          playerId: room.phase === 'reveal' ? s.playerId : undefined,
          playerName: room.phase === 'reveal' ? (room.players.find(p => p.id === s.playerId)?.displayName || room.players.find(p => p.id === s.playerId)?.name) : undefined,
          isStoryteller: room.phase === 'reveal' ? s.playerId === storyteller?.id : undefined,
          votes: room.phase === 'reveal' 
            ? Object.entries(room.votes).filter(([_, v]) => v === s.displayNumber).map(([oderId]) => room.players.find(p => p.id === oderId)?.name)
            : undefined
        }))
      : null,
    // Player status for game UI
    playerStatus: room.players.map(p => ({
      id: p.id,
      name: p.displayName || p.name,
      score: p.score,
      isBot: p.isBot,
      type: p.type,
      isStoryteller: p.id === storyteller?.id,
      hasSubmitted: room.submittedCards.some(s => s.playerId === p.id),
      hasVoted: !!room.votes[p.id]
    })),
    lastUpdate: room.lastUpdate
  });
});

// Start game
app.post('/api/room/:roomCode/start', (req, res) => {
  const { roomCode } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.host !== playerId) return res.status(403).json({ error: '只有房主可以開始遊戲' });
  if (room.players.length < 3) return res.status(400).json({ error: '需要至少3位玩家' });

  room.phase = 'storytelling';
  room.round = 1;
  room.storytellerIndex = 0;
  room.lastUpdate = Date.now();

  res.json({ success: true });
  
  // Trigger bot actions if storyteller is a bot
  setTimeout(() => processBotActions(room), 500);
});

// Submit story (storyteller)
app.post('/api/room/:roomCode/story', (req, res) => {
  const { roomCode } = req.params;
  const { playerId, cardId, story } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });

  const storyteller = room.players[room.storytellerIndex];
  if (storyteller.id !== playerId) return res.status(403).json({ error: '你不是說書人' });

  room.story = story;
  room.storytellerCard = cardId;

  // Remove card from hand
  const card = storyteller.hand.find(c => c.id === cardId);
  storyteller.hand = storyteller.hand.filter(c => c.id !== cardId);

  room.phase = 'selecting';
  room.submittedCards = [{ playerId, card }];
  room.lastUpdate = Date.now();

  res.json({ success: true, hand: storyteller.hand });
  
  // Trigger bot card selection
  setTimeout(() => processBotActions(room), 500);
});

// Submit card (non-storyteller)
app.post('/api/room/:roomCode/card', (req, res) => {
  const { roomCode } = req.params;
  const { playerId, cardId } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.phase !== 'selecting') return res.status(400).json({ error: '現在不是選牌階段' });

  const player = room.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: '找不到玩家' });

  // Check if already submitted
  if (room.submittedCards.find(s => s.playerId === playerId)) {
    return res.status(400).json({ error: '你已經選過牌了' });
  }

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return res.status(400).json({ error: '你沒有這張牌' });

  player.hand = player.hand.filter(c => c.id !== cardId);
  room.submittedCards.push({ playerId, card });
  room.lastUpdate = Date.now();
  
  console.log(`[${roomCode}] ${player.name} 選了牌 (${room.submittedCards.length}/${room.players.length})`);

  // Check if all submitted
  if (room.submittedCards.length === room.players.length) {
    room.submittedCards = shuffle(room.submittedCards);
    room.submittedCards.forEach((s, i) => s.displayNumber = i + 1);
    room.phase = 'voting';
    room.votes = {};
    console.log(`[${roomCode}] 所有人都選牌了，進入投票階段`);
    
    // Trigger bot voting
    setTimeout(() => processBotActions(room), 500);
  }

  res.json({ success: true, hand: player.hand });
});

// Vote
app.post('/api/room/:roomCode/vote', (req, res) => {
  const { roomCode } = req.params;
  const { playerId, displayNumber } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.phase !== 'voting') return res.status(400).json({ error: '現在不是投票階段' });

  const storyteller = room.players[room.storytellerIndex];
  if (storyteller.id === playerId) return res.status(403).json({ error: '說書人不能投票' });

  // Can't vote for own card
  const ownCard = room.submittedCards.find(s => s.playerId === playerId);
  if (ownCard && ownCard.displayNumber === displayNumber) {
    return res.status(400).json({ error: '不能投自己的牌' });
  }

  room.votes[playerId] = displayNumber;
  room.lastUpdate = Date.now();

  // Check if all voted
  if (Object.keys(room.votes).length === room.players.length - 1) {
    calculateScores(room);
  }

  res.json({ success: true });
});

// Add bot player (host only)
app.post('/api/room/:roomCode/add-bot', (req, res) => {
  const { roomCode } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.host !== playerId) return res.status(403).json({ error: '只有房主可以加入電腦玩家' });
  if (room.phase !== 'waiting') return res.status(400).json({ error: '遊戲已經開始' });
  if (room.players.length >= 8) return res.status(400).json({ error: '房間已滿' });

  // Pick unused bot name
  const usedNames = room.players.filter(p => p.isBot).map(p => p.name.replace('(🤖)', '').trim());
  const availableNames = botNames.filter(n => !usedNames.includes(n));
  const botName = availableNames.length > 0 
    ? availableNames[Math.floor(Math.random() * availableNames.length)]
    : `電腦${room.players.filter(p => p.isBot).length + 1}`;

  const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
  const bot = {
    id: botId,
    name: botName,
    displayName: `${botName}(🤖)`,
    type: 'bot',
    hand: room.deck.splice(0, 6),
    score: 0,
    isBot: true,
    lastSeen: Date.now()
  };

  room.players.push(bot);
  room.lastUpdate = Date.now();
  
  console.log(`[${roomCode}] 電腦玩家 ${bot.name} 加入了`);

  res.json({ 
    success: true, 
    bot: { id: bot.id, name: bot.name, score: 0 },
    players: room.players.map(p => ({ id: p.id, name: p.displayName || p.name, score: p.score, isBot: p.isBot }))
  });
});

// Leave room (any player)
app.post('/api/room/:roomCode/leave', (req, res) => {
  const { roomCode } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });

  const playerIndex = room.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return res.status(404).json({ error: '找不到玩家' });

  const player = room.players[playerIndex];
  
  // Return cards to deck
  room.deck = room.deck.concat(player.hand);
  
  // Remove player
  room.players.splice(playerIndex, 1);
  players.delete(playerId);
  room.lastUpdate = Date.now();
  
  console.log(`[${roomCode}] ${player.name} 離開了房間`);

  // If host left, assign new host
  if (room.host === playerId && room.players.length > 0) {
    room.host = room.players[0].id;
    console.log(`[${roomCode}] 新房主: ${room.players[0].name}`);
  }

  // If room empty, delete it
  if (room.players.length === 0) {
    rooms.delete(roomCode.toUpperCase());
    console.log(`[${roomCode}] 房間已空，自動刪除`);
  }

  res.json({ success: true });
});

// Disband room (host only)
app.post('/api/room/:roomCode/disband', (req, res) => {
  const { roomCode } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.host !== playerId) return res.status(403).json({ error: '只有房主可以解散房間' });

  // Clean up player records
  room.players.forEach(p => players.delete(p.id));
  rooms.delete(roomCode.toUpperCase());
  
  console.log(`Room ${roomCode} disbanded by host`);
  res.json({ success: true });
});

// Next round
app.post('/api/room/:roomCode/next', (req, res) => {
  const { roomCode } = req.params;
  const { playerId } = req.body;

  const room = rooms.get(roomCode.toUpperCase());
  if (!room) return res.status(404).json({ error: '房間不存在' });
  if (room.host !== playerId) return res.status(403).json({ error: '只有房主可以進入下一回合' });

  // 把這回合打出的牌回收到牌組底部（洗牌後）
  const usedCards = room.submittedCards.map(s => s.card);
  room.deck = room.deck.concat(shuffle(usedCards));
  
  // Deal new cards
  room.players.forEach(p => {
    while (p.hand.length < 6 && room.deck.length > 0) {
      p.hand.push(room.deck.shift());
    }
  });

  room.round++;
  room.storytellerIndex = (room.storytellerIndex + 1) % room.players.length;
  room.phase = 'storytelling';
  room.story = '';
  room.storytellerCard = null;
  room.submittedCards = [];
  room.votes = {};
  room.lastUpdate = Date.now();

  res.json({ success: true });
  
  // Trigger bot actions if new storyteller is a bot
  setTimeout(() => processBotActions(room), 500);
});

// Cleanup old rooms (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastUpdate > 30 * 60 * 1000) {
      rooms.delete(code);
      console.log(`Room ${code} expired`);
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 8766;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦞 小龍蝦說書人伺服器運行中: http://localhost:${PORT}`);
  console.log(`🌊 Moltbook Edition for seafood friends!`);
});
