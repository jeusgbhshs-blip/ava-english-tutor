/**
 * 演示模式内容（无 API Key 时使用）：脚本化英文回复 + 规则纠错。
 * 保证无网络也能完整体验「对话 → 纠错 → 生词 → 鼓励」闭环。
 */
import { freeTalkTopics, roleplayScenarios } from './scenarios.js';
import { vocabTopics } from './vocab.js';
import { freeOpeners } from './openers.js';
import { findCharacter } from './characters.js';

const ROLEPLAY_LINES = {
  coffee: [
    'Great choice! A medium latte sounds good. Would you like it hot or iced?',
    'Perfect, one iced latte. Do you want regular milk or oat milk?',
    'Sure! That comes to five dollars. Would you like to pay by card or cash?',
    'Thank you! Your drink will be ready in two minutes. Have a lovely day!',
  ],
  airport: [
    'Thank you. You are flying to Singapore today, is that correct? How many bags are you checking in?',
    'Great, one bag. Would you prefer a window seat or an aisle seat?',
    'All set. Your gate is B12, and boarding starts at 10:40. Do you have any questions?',
    'You are welcome! Have a pleasant flight.',
  ],
  interview: [
    'Nice to meet you. Could you tell me about your current role and what you are responsible for?',
    'I see. What would you say is your greatest strength?',
    'Good answer. Can you give me an example of a difficult problem you solved?',
    'That is helpful. Do you have any questions for me about the team or the role?',
  ],
  hotel: [
    'Yes, I found your reservation. Could I see your passport, please?',
    'Thank you. Your room is on the eighth floor, and here is your key card. Breakfast is served from seven to ten.',
    'The WiFi password is on the card. Is there anything else I can help you with?',
    'You are welcome. Enjoy your stay!',
  ],
};

const FREE_TALK_LINES = {
  cafe: [
    "That sounds great! I love a good cup of coffee. What's your favorite coffee?",
    'Nice! How do you usually order your coffee — hot or iced?',
    'I see! Do you prefer drinking coffee at home or in a café?',
  ],
  travel: [
    'That sounds exciting! Where would you like to travel next?',
    'I love that. What was the most memorable trip you have taken?',
    'Interesting! Do you prefer travelling alone or with friends?',
  ],
  daily: [
    "That's nice to hear! What do you usually do on weekends?",
    'Sounds good! How is the weather today where you are?',
    'I see. What time do you usually get up in the morning?',
  ],
  hobbies: [
    'That sounds fun! How did you start this hobby?',
    'I love that. How often do you do it?',
    'Great! Would you like to learn something new this year?',
  ],
  food: [
    'Yummy! What is your favorite dish?',
    'Sounds delicious! Do you like cooking?',
    'Nice! Have you ever tried food from another country?',
  ],
  movies: [
    'Nice taste! Can you recommend a movie and explain why you like it?',
    'I see! Do you prefer watching movies at home or in the cinema?',
    'Interesting! What kind of movies do you enjoy most?',
  ],
  interview: [
    'Thanks for coming in! Could you introduce yourself briefly?',
    'Good. What are your strengths and weaknesses?',
    'Nice. Where do you see yourself in five years?',
  ],
  workstudy: [
    'That sounds busy! What are you working on these days?',
    'I see. How do you usually manage your time?',
    'Interesting. What skill would you like to improve this year?',
  ],
};

/** 角色扮演场景 → 相关单词主题 */
const SCENARIO_TOPIC = { coffee: 'cafe', airport: 'travel', hotel: 'travel', interview: 'work', cafe: 'cafe' };

const ENCOURAGEMENTS = [
  '这句表达很清楚，继续保持！',
  '主动开口就是进步，很棒！',
  '时态用得不错，再自然一点就更好啦。',
  '发音节奏很好，我听到你的进步了！',
  '很棒，信息表达完整，继续加油！',
  '这个词汇用得恰到好处！',
];




/* ---------------------------- v1.6 角色 demo 回复 ---------------------------- */

/**
 * 角色文字聊天的演示回复：开场用角色/场景台词，后续复用朋友式回复。
 * @param {{characterId?:string, sceneId?:string, message?:string, history?:object[]}} opts
 */
export function buildDemoCharacterReply({ characterId = 'elena', sceneId = '', message = '', history = [] } = {}) {
  const character = findCharacter(characterId);
  const empty = { corrections: [], better: [], newWords: [], encouragement_zh: '', followUp: '', chineseHelp: null };
  if (!character) return buildDemoReply({ mode: 'free', message, history });
  const turns = (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user').length;
  const scene = character.scenes.find((s) => s.id === sceneId) || character.scenes[0];
  if (!String(message || '').trim() || turns === 0) {
    return {
      text: scene?.opener || character.greeting,
      feedback: { ...empty, encouragement_zh: `这是 ${character.name} 的开场，接着她的话聊下去吧。` },
    };
  }
  if (detectChinese(message)) {
    const chineseHelp = buildChineseHelp(message);
    return {
      text: chineseHelp.unmatched
        ? `No worries — start with "What I'm trying to say is …" and explain simply. What do you want to tell me?`
        : `No worries — in English you can say: "${chineseHelp.english}" Let's keep talking.`,
      feedback: {
        ...empty,
        chineseHelp,
        encouragement_zh: '这句英文表达已经给你了，读一遍再继续聊。',
      },
    };
  }
  const base = buildDemoReply({ mode: 'free', message, history });
  return base;
}

/* ============================ v1.3 阅读讲解（demo） ============================ */

const DOC_STOPWORDS = new Set(
  ('the a an and or but if then than that this these those is are was were be been being am do does did have has had ' +
    'will would can could should may might must shall of to in on at for with by from as it its i you he she we they me ' +
    'him her us them my your his our their not no yes so very just really also about into over under again more most some ' +
    'any all each other such only own same too there here what which who whom whose when where why how').split(/\s+/),
);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeEnglish(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[a-z][a-z'-]{2,}/g) || [];
}

function splitSentences(text) {
  const normalized = String(text || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?]+[.!?]+/g) || [normalized];
  return parts.map((p) => p.trim()).filter((p) => p.length > 10);
}

/**
 * 规则版阅读材料分析（无 Key / 模型失败时使用）。
 * @returns {{summary_zh:string, keyPoints:{en:string,zh:string}[], keyWords:object[], questions:{en:string,zh:string}[], readAloud:string, wordCount:number, demo:boolean}}
 */
export function buildDemoDocAnalysis({ text = '', name = '', level = 'A2' } = {}) {
  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return {
      summary_zh: '这份材料没有可分析的文字内容。',
      keyPoints: [],
      keyWords: [],
      questions: [],
      readAloud: '',
      wordCount: 0,
      demo: true,
    };
  }
  const wordCount = cleaned.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
  const sentences = splitSentences(cleaned);
  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 40);
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines.find((l) => l.length < 90 && !/[.!?]$/.test(l)) || name || 'Reading material';

  // 词频
  const freq = new Map();
  for (const word of tokenizeEnglish(cleaned)) {
    if (DOC_STOPWORDS.has(word) || word.length < 4) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const topWords = ranked.slice(0, 8).map(([w]) => w);

  // 优先用内置词库解释重点词
  const keyWords = [];
  for (const topic of vocabTopics) {
    for (const word of topic.words) {
      if (keyWords.length >= 8) break;
      if (new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'i').test(cleaned) && !keyWords.some((k) => k.word === word.word)) {
        keyWords.push({ word: word.word, phonetic: word.phonetic, meaning: word.meaning, example: word.example, why_zh: '材料中出现的重点词' });
      }
    }
  }
  for (const [word, count] of ranked) {
    if (keyWords.length >= 8) break;
    if (keyWords.some((k) => k.word.toLowerCase() === word)) continue;
    const sentence = sentences.find((s) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(s)) || cleaned.slice(0, 160);
    keyWords.push({
      word,
      phonetic: '',
      meaning: '文中高频词（建议查词典确认释义）',
      example: sentence.slice(0, 200),
      why_zh: `在文中出现 ${count} 次，值得掌握`,
    });
  }

  const pointSources = paragraphs.length >= 3 ? paragraphs.slice(0, 4) : sentences.slice(0, 4);
  const keyPoints = pointSources
    .slice(0, 4)
    .map((p) => (paragraphs.length >= 3 ? splitSentences(p)[0] || p : p))
    .filter(Boolean)
    .map((en) => ({ en: en.slice(0, 300), zh: '原文要点，建议朗读并用自己的话复述。' }));

  const questions = [{ en: 'What is the main idea of this text?', zh: '这篇文章的主旨是什么？' }];
  if (topWords[0]) {
    questions.push({ en: `According to the text, what does it say about "${topWords[0]}"?`, zh: `根据文章，关于“${topWords[0]}”它说了什么？` });
  }
  questions.push({ en: 'Which sentence in the text do you find most interesting? Why?', zh: '你觉得文中哪一句最有趣？为什么？' });
  questions.push({ en: 'Do you agree with the main idea? Why or why not?', zh: '你同意文章的主要观点吗？为什么？' });

  let readAloud = '';
  for (const sentence of sentences) {
    if ((readAloud + sentence).length > 800) break;
    readAloud += `${sentence} `;
  }
  if (!readAloud) readAloud = cleaned.slice(0, 800);

  const summary = `这份材料《${name || title}》约 ${wordCount} 个英文单词、${Math.max(1, paragraphs.length)} 段。核心主题词：${topWords.slice(0, 5).join('、') || '（较短）'}。可以先听我朗读抓大意，再跟着我逐句精读，重点掌握 ${keyWords.slice(0, 3).map((w) => w.word).join('、') || '关键词汇'}。`;

  return { summary_zh: summary, keyPoints, keyWords, questions, readAloud: readAloud.trim(), wordCount, demo: true };
}

function docFeedbackBase(analysis) {
  return {
    corrections: [],
    better: [],
    newWords: Array.isArray(analysis.keyWords)
      ? analysis.keyWords.slice(0, 2).map((w) => ({ word: w.word, phonetic: w.phonetic || '', meaning: w.meaning || '', example: w.example || '' }))
      : [],
    encouragement_zh: '',
    followUp: '',
    chineseHelp: null,
  };
}

/**
 * 演示模式的阅读讲解回复：开场介绍 + 逐题提问 + 中文求助。
 * @returns {{text:string, feedback:object}}
 */
export function buildDemoReadingReply({ doc = {}, analysis = {}, message = '', history = [] } = {}) {
  const questions = (Array.isArray(analysis.questions) ? analysis.questions : []).map((q) => q.en).filter(Boolean);
  const historyUserCount = (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user').length;
  const trimmedMessage = String(message || '').trim();
  // 只有空消息或明确的“开始”指令才算开场；第一次回答时 history 里没有 user，不能被误判成开场
  const isStart =
    !trimmedMessage ||
    /^(start reading|let's start|开始讲解|开始阅读|start)\b/i.test(trimmedMessage) ||
    /introduce this text/i.test(trimmedMessage);
  // 当前消息算一轮：回答第 1 题后 → 问第 2 题
  const answeredTurns = isStart ? historyUserCount : historyUserCount + 1;
  const docName = doc.name || 'this text';
  const nextQuestion = () => questions[Math.min(answeredTurns, Math.max(0, questions.length - 1))] || 'What is the main idea of this text?';

  // 中文求助
  if (detectChinese(message)) {
    const chineseHelp = buildChineseHelp(message);
    const feedback = docFeedbackBase(analysis);
    feedback.encouragement_zh = '这句英文表达已经给你了，点「跟我读」念一遍再继续读文章。';
    feedback.chineseHelp = chineseHelp;
    const text = chineseHelp.unmatched
      ? `No worries — asking in Chinese is fine. Start with: "What I'm trying to say is …" and then explain simply. Let's continue reading: ${nextQuestion()}`
      : `No worries — in English you can say: "${chineseHelp.english}" Now let's continue: ${nextQuestion()}`;
    return { text, feedback };
  }

  // 开始讲解（空消息 / server 合成消息触发）
  if (isStart) {
    const firstQ = questions[0] || 'What is the main idea of this text?';
    const text = `Let's read "${docName}" together. I'll explain the key parts as we go and ask you a few questions. First question: ${firstQ}`;
    const feedback = docFeedbackBase(analysis);
    feedback.encouragement_zh = '先听我读一遍关键句，再试着自己回答第一个问题。';
    return { text, feedback };
  }

  const asksQuestion = isQuestion(message) || /\b(what|why|how|explain|mean|meaning|translate)\b/i.test(message);
  const feedback = docFeedbackBase(analysis);
  const corrections = detectCorrections(message);
  feedback.corrections = corrections.slice(0, 2);
  feedback.encouragement_zh = corrections.length ? '我帮你把表达改得更自然了，读一遍试试。' : '回答得不错，继续跟着问题把文章读下去。';

  if (asksQuestion) {
    const quote = analysis.keyPoints?.[0]?.en || String(analysis.readAloud || '').slice(0, 140);
    const text = `Good question. The text says: "${quote}" — in simple words, that's the main point. ${answeredTurns < questions.length ? `Next question: ${nextQuestion()}` : 'What do you think about it overall?'}`;
    return { text, feedback };
  }

  const text = `Thanks for your answer — I like how you put it. ${answeredTurns < questions.length ? `Next question: ${nextQuestion()}` : 'Last one: what is your own opinion about this text?'}`;
  return { text, feedback };
}

/* ---------------- 自由对话：朋友式回复 ---------------- */

/** 关键词 → 朋友口吻回复（free 模式，完全不依赖话题卡） */
const FREE_REPLY_RULES = [
  {
    re: /\b(work|job|office|boss|meeting|deadline|colleague|project|salary|career|overtime)\b/i,
    replies: [
      "Ugh, work sounds intense right now. I had a day full of meetings too — I honestly zoned out twice 😅 Is this a busy season for you, or is it always like this?",
      "That's a lot to handle. I'm curious though — what part of your work do you actually enjoy? There must be something.",
      "I hear you. Sometimes I wish I could just close my laptop and go for a walk. If you had a free afternoon tomorrow, what would you do?",
    ],
  },
  {
    re: /\b(study|exam|school|class|homework|teacher|university|course|test|learn|learning)\b/i,
    replies: [
      "Studying can be such a grind, but I love that you're putting in the effort. What's the hardest part for you right now?",
      "Oh, I remember exam season — coffee, notes everywhere, mild panic 😅 How are you managing your time?",
      "That sounds interesting! What made you choose this subject in the first place?",
    ],
  },
  {
    re: /\b(travel|trip|flight|airport|holiday|vacation|beach|hotel|visit|abroad)\b/i,
    replies: [
      "Ooh, travel talk — my favorite! Where would you go if money and time didn't matter at all?",
      "That sounds exciting. I'm curious — do you prefer planning everything, or just wandering around?",
      "I love that. What's the most memorable trip you've taken so far?",
    ],
  },
  {
    re: /\b(food|eat|restaurant|cook|cooking|dinner|lunch|breakfast|delicious|spicy|coffee|tea|latte|hungry)\b/i,
    replies: [
      "Okay, now I'm hungry 😄 What's the best thing you've eaten recently?",
      "I love food talk. Do you cook yourself, or is it more takeaway for you?",
      "That sounds delicious! If you could only eat one dish for a whole week, what would it be?",
    ],
  },
  {
    re: /\b(movie|film|series|show|watch|netflix|drama|actor|episode)\b/i,
    replies: [
      "I'm always looking for something good to watch — what was it about?",
      "Nice! Give me a one-sentence pitch: why should I watch it?",
      "I love a good show. Would you recommend it to a friend, or is it a guilty pleasure?",
    ],
  },
  {
    re: /\b(hobby|sport|run|running|gym|game|gaming|music|guitar|piano|read|reading|draw|hiking|photography)\b/i,
    replies: [
      "That sounds fun! How did you get into it?",
      "I love hearing about people's hobbies. How often do you get to do it?",
      "That's cool. Is it something you'd like to get better at this year?",
    ],
  },
  {
    re: /\b(tired|exhausted|stress|stressed|overwhelmed|sleepy|nervous|worried|sad|upset|angry|annoyed|bad day)\b/i,
    replies: [
      "Oh no, I'm sorry you're feeling that way. Do you want to talk about what happened?",
      "That sounds exhausting, honestly. What's one small thing that would make today a little better?",
      "I get it — some days are just heavy. I'm here, take your time. What's on your mind?",
    ],
  },
  {
    re: /\b(happy|excited|glad|great|awesome|amazing|fun|proud|grateful|good news)\b/i,
    replies: [
      "I love that energy! Tell me more — what happened?",
      "That's wonderful, seriously. What part of it made you happiest?",
      "Aw, that made me smile too. What's next for you?",
    ],
  },
  {
    re: /\b(weekend|plan|tomorrow|next week|future|schedule|going to)\b/i,
    replies: [
      "Ooh, plans! What are you most looking forward to?",
      "That sounds nice. Are you the kind of person who makes a plan, or figures it out as you go?",
      "I love weekends. If you had one totally free day with no obligations, what would you do?",
    ],
  },
  {
    re: /\b(friend|family|mom|mother|dad|father|brother|sister|partner|girlfriend|boyfriend|parents)\b/i,
    replies: [
      "That sounds really meaningful. How often do you get to spend time together?",
      "I love that. What's something they do that always makes you smile?",
      "Family and friends make life better, honestly. What did you talk about?",
    ],
  },
  {
    re: /\b(weather|rain|raining|sunny|cold|hot|windy|snow|cloudy|sun)\b/i,
    replies: [
      "The weather really changes my mood, honestly. What's it like where you are right now?",
      "Ugh, I know that feeling. Does this weather make you want to stay in or go out?",
      "I'm a sunshine person myself. What's your perfect weather day?",
    ],
  },
  {
    re: /\b(money|buy|shopping|expensive|cheap|price|save|budget)\b/i,
    replies: [
      "Money talk — always interesting. Are you more of a saver or a spender?",
      "I get that. What's something you bought recently that was totally worth it?",
      "That makes sense. Do you have a big goal you're saving for?",
    ],
  },
];

const FREE_FALLBACK_REPLIES = [
  "I'm really glad you shared that with me. Tell me more — how did it make you feel?",
  "That's interesting! I want the details — what happened next?",
  "Mm, I get it. I've had days like that too, honestly. What are you going to do about it?",
  "I love this conversation. What's been the best part of your day so far?",
  "Okay, now I'm curious — tell me one more thing about that.",
  "Honestly, I could listen to you talk about this all day. What else is new with you?",
  "I like where this conversation is going. What made you think about that today?",
];

const FREE_SHORT_REPLIES = [
  "Haha, short and sweet! Give me a little more — what was the highlight of your day?",
  "I like that answer. And how are you feeling right now, honestly?",
  "Okay, I'll bite — tell me a little more?",
  "Fair enough! Then let me ask you this: what are you looking forward to this week?",
];


/* ============================ v1.2 中文求助 + 相关性增强 ============================ */

/** 是否包含中文 */
export function detectChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

const CN_NOUN_MAP = {
  咖啡: 'coffee', 电影: 'movies', 音乐: 'music', 旅行: 'traveling', 运动: 'sports',
  读书: 'reading', 游戏: 'games', 美食: 'food', 猫: 'cats', 狗: 'dogs', 做饭: 'cooking', 跑步: 'running',
};
const CN_WANT_MAP = {
  咖啡: 'a coffee', 水: 'some water', 茶: 'some tea', 拿铁: 'a latte', 啤酒: 'a beer',
  休息: 'to take a break', 睡觉: 'to go to sleep', 回家: 'to go home',
};

const CN_FALLBACK_TIPS =
  '演示模式暂时只能翻译常见中文表达。你可以先用英文句式 "What I\'m trying to say is …"，再用简单英文把意思补完整；填入 API Key 后，Ava 能理解任意中文并教你怎么说。';

/** 高频中文 → 地道英文（含意群拆解与提示） */
const CN_HELP_RULES = [
  {
    re: /(不知道怎么说|不知道该怎么|不会说|怎么表达|说不出来)/, meta: true,
    en: "I'm not sure how to say this in English.",
    chunks: [{ en: "I'm not sure", zh: '我不确定' }, { en: 'how to say this', zh: '这个该怎么说' }],
    tips: '不会说时先用这句过渡，再用简单词解释，别停在中文上。',
  },
  {
    re: /(我听不懂|听不懂|没听懂|听不太懂|听不明白)/, meta: true,
    en: "I didn't quite catch that. Could you say it again, please?",
    chunks: [{ en: "I didn't quite catch that", zh: '我没太听清' }, { en: 'Could you say it again', zh: '你能再说一遍吗' }],
    tips: 'catch 在这里是“听清、听懂”，比 hear 更地道。',
  },
  {
    re: /(什么意思|啥意思|是什么意思)/, meta: true,
    en: 'What does that mean?',
    chunks: [{ en: 'What does that mean', zh: '那是什么意思' }],
    tips: '问单词/句子意思时用 What does … mean? 不要用 What mean。',
  },
  {
    re: /(再说一遍|再讲一遍|重复一下)/, meta: true,
    en: 'Could you say that again, please?',
    chunks: [{ en: 'Could you say that again', zh: '你能再说一遍吗' }, { en: 'please', zh: '请（礼貌）' }],
    tips: '加 please 会礼貌很多。',
  },
  {
    re: /(慢一点|说慢点|说慢一点|讲慢一点)/, meta: true,
    en: 'Could you speak a little more slowly, please?',
    chunks: [{ en: 'Could you speak', zh: '你能说' }, { en: 'a little more slowly', zh: '再慢一点' }],
    tips: 'slowly 是副词，修饰 speak。',
  },
  {
    re: /(累了|很累|太累|累死|好累|累坏)/,
    en: "I'm exhausted today.",
    chunks: [{ en: "I'm exhausted", zh: '我累坏了' }, { en: 'today', zh: '今天' }],
    tips: 'exhausted 比 tired 语气更强，适合“累坏了”。',
  },
  {
    re: /(我饿了|好饿|饿死了|太饿了)/,
    en: "I'm starving. / I'm really hungry.",
    chunks: [{ en: "I'm starving", zh: '我饿坏了' }],
    tips: 'starving 是口语里“饿坏了”的说法。',
  },
  {
    re: /(我渴了|好渴)/,
    en: "I'm thirsty.",
    chunks: [{ en: "I'm thirsty", zh: '我渴了' }],
    tips: '注意发音 /ˈθɜːsti/，th 要咬舌。',
  },
  {
    re: /(我很忙|我最近很忙|忙死了|太忙了)/,
    en: "I've been really busy lately.",
    chunks: [{ en: "I've been really busy", zh: '我一直很忙' }, { en: 'lately', zh: '最近' }],
    tips: "I've been… 表示“最近一直”的状态。",
  },
  {
    re: /(我在工作|我在上班|我正在工作)/,
    en: "I'm at work right now.",
    chunks: [{ en: "I'm at work", zh: '我在上班' }, { en: 'right now', zh: '现在' }],
    tips: 'at work 是固定搭配，不用 in work。',
  },
  {
    re: /(我在学英语|我在学英文|我在学习英语)/,
    en: "I'm learning English.",
    chunks: [{ en: "I'm learning", zh: '我正在学' }, { en: 'English', zh: '英语' }],
    tips: 'learn 用进行时可表示“最近在学”。',
  },
  {
    re: /(我英语不好|我英文不好|我英语很差)/,
    en: "My English isn't very good yet, but I'm improving.",
    chunks: [{ en: "My English isn't very good yet", zh: '我的英语还不太好' }, { en: "but I'm improving", zh: '但我一直在进步' }],
    tips: '加 yet 表示“还（在进步）”，态度更积极。',
  },
  {
    re: /(我开心|我很开心|我高兴|我很高兴|太好了)/,
    en: "I'm really happy.",
    chunks: [{ en: "I'm really happy", zh: '我真的开心' }],
    tips: '想更强可以说 I\'m over the moon（开心到飞起）。',
  },
  {
    re: /(我难过|我很伤心|我很难过|我心情不好)/,
    en: 'I feel really sad.',
    chunks: [{ en: 'I feel really sad', zh: '我很难过' }],
    tips: 'feel + 形容词，表达当下的感受。',
  },
  {
    re: /(我紧张|我很紧张|我好紧张)/,
    en: "I'm really nervous.",
    chunks: [{ en: "I'm really nervous", zh: '我很紧张' }],
    tips: 'nervous 是“紧张、不安”，不是“生气”。',
  },
  {
    re: /(我生气|我很生气|气死了)/,
    en: "I'm really angry.",
    chunks: [{ en: "I'm really angry", zh: '我很生气' }],
    tips: '口语也可以说 I\'m so annoyed（有点烦）。',
  },
  {
    re: /(我无聊|好无聊|太无聊了)/,
    en: "I'm so bored.",
    chunks: [{ en: "I'm so bored", zh: '我好无聊' }],
    tips: 'bored 形容人，boring 形容事物，别弄反。',
  },
  {
    re: /(我困了|好困|想睡觉)/,
    en: "I'm sleepy. I think I need some rest.",
    chunks: [{ en: "I'm sleepy", zh: '我困了' }, { en: 'I need some rest', zh: '我需要休息一下' }],
    tips: 'sleepy 是“困”，sleep 是动词“睡觉”。',
  },
  {
    re: /(今天天气|天气很好|天气不错|天气真好)/,
    en: 'The weather is really nice today.',
    chunks: [{ en: 'The weather is really nice', zh: '天气真好' }, { en: 'today', zh: '今天' }],
    tips: '聊天气是英语里的万能破冰话题。',
  },
  {
    re: /(我是学生|我在上学)/,
    en: "I'm a student.",
    chunks: [{ en: "I'm a student", zh: '我是学生' }],
    tips: '职业/身份前要加 a/an。',
  },
  {
    re: /(我是上班族|我上班|我在公司工作)/,
    en: 'I work at a company.',
    chunks: [{ en: 'I work at a company', zh: '我在公司上班' }],
    tips: 'work at + 公司/地点 是固定搭配。',
  },
  {
    re: /(真的吗|是吗|不会吧)/,
    en: 'Really?',
    chunks: [{ en: 'Really', zh: '真的吗' }],
    tips: '用升调读，表示惊讶/想继续听。',
  },
  {
    re: /(为什么|为啥)/,
    en: 'Why?',
    chunks: [{ en: 'Why', zh: '为什么' }],
    tips: '想更完整可以说 Why do you think so?',
  },
  {
    re: /(谢谢|多谢|感谢)/,
    en: 'Thank you so much.',
    chunks: [{ en: 'Thank you', zh: '谢谢' }, { en: 'so much', zh: '非常' }],
    tips: 'th 要咬舌，别读成 s。',
  },
  {
    re: /(对不起|抱歉|不好意思)/,
    en: "I'm sorry. / Excuse me.",
    chunks: [{ en: "I'm sorry", zh: '对不起' }, { en: 'Excuse me', zh: '不好意思/打扰一下' }],
    tips: '小事打扰用 Excuse me，道歉用 I\'m sorry。',
  },
  {
    re: /(这个用英语怎么说|用英语怎么说|英文怎么说)/, meta: true,
    en: 'How do you say this in English?',
    chunks: [{ en: 'How do you say this', zh: '这个怎么说' }, { en: 'in English', zh: '用英语' }],
    tips: '这是最实用的求助句式，记住它。',
  },
  {
    re: /(我不知道(?!怎么说|该怎么|怎么表达|说什么)|我不太清楚|不清楚)/,
    en: "I don't know. Let me think for a second.",
    chunks: [{ en: "I don't know", zh: '我不知道' }, { en: 'Let me think', zh: '让我想想' }],
    tips: '加 Let me think 能给自己争取时间，更自然。',
  },
  {
    re: /(我同意|我也是这么想)/,
    en: 'I agree with you.',
    chunks: [{ en: 'I agree', zh: '我同意' }, { en: 'with you', zh: '和你（看法一致）' }],
    tips: 'agree 后接 with + 人，agree to + 计划。',
  },
  {
    re: /(我不同意|我不这么认为)/,
    en: "I'm afraid I disagree.",
    chunks: [{ en: "I'm afraid I disagree", zh: '恐怕我不同意(委婉)' }],
    tips: '加 I\'m afraid 会委婉很多。',
  },
  {
    re: /(我觉得|我认为|我猜)/,
    en: 'I think …',
    chunks: [{ en: 'I think', zh: '我觉得' }, { en: '…', zh: '后面接一个完整英文句子' }],
    tips: 'I think 后面要接完整句子，例如 I think it\'s a good idea。',
  },
  {
    re: /(你好|嗨|哈喽)/,
    en: 'Hi, how are you?',
    chunks: [{ en: 'Hi', zh: '你好' }, { en: 'how are you', zh: '你好吗' }],
    tips: '回答可以说 I\'m good, thanks. And you?',
  },
  {
    re: /(我可以|我能|可不可以)/,
    en: 'Can I …?',
    chunks: [{ en: 'Can I', zh: '我可以' }, { en: '…', zh: '后面接动词原形' }],
    tips: 'Can I 后面接动词原形，例如 Can I ask a question?',
  },
  {
    re: /(我需要|我得)/,
    en: 'I need …',
    chunks: [{ en: 'I need', zh: '我需要' }, { en: '…', zh: '后面接名词或 to do' }],
    tips: 'I need 后面接名词或 to do，例如 I need some water / I need to go now。',
  },
  {
    re: /(我周末|周末我|这个周末)/,
    en: "This weekend I'm going to relax at home.",
    chunks: [{ en: "This weekend I'm going to", zh: '这个周末我打算' }, { en: 'relax at home', zh: '在家放松' }],
    tips: 'be going to + 动词原形 表示计划。',
  },
  {
    re: /(我想问你|我能问你|问你个问题)/,
    en: 'Can I ask you something?',
    chunks: [{ en: 'Can I ask you something', zh: '我能问你件事吗' }],
    tips: 'something 用于请求，不做主语。',
  },
  {
    re: /(你叫什么名字|你名字是什么)/,
    en: "What's your name?",
    chunks: [{ en: "What's your name", zh: '你叫什么名字' }],
    tips: '问名字直接 What\'s your name? 不用 How are you called。',
  },
  {
    re: /(你几岁|你多大了|你多大)/,
    en: 'How old are you?',
    chunks: [{ en: 'How old are you', zh: '你多大了' }],
    tips: '英文用 how old 问年龄，不用 how many years。',
  },
  {
    re: /(很高兴认识你|认识你很高兴)/,
    en: 'Nice to meet you.',
    chunks: [{ en: 'Nice to meet you', zh: '很高兴认识你' }],
    tips: '第一次见面用 Nice to meet you，熟人说 Good to see you。',
  },
];

/**
 * 规则版中文 → 英文翻译（demo 模式）。
 * @returns {{original_zh:string, english:string, chunks:{en:string,zh:string}[], tips_zh:string, unmatched:boolean}}
 */
export function buildChineseHelp(text) {
  const original_zh = String(text || '').trim().slice(0, 300);
  if (!original_zh) return null;
  const like = original_zh.match(/喜欢(.{1,6}?)(?:[，。,.！!？?]|$)/);
  if (like && CN_NOUN_MAP[like[1].trim()]) {
    const noun = CN_NOUN_MAP[like[1].trim()];
    return {
      original_zh,
      english: `I really like ${noun}.`,
      chunks: [{ en: 'I really like', zh: '我真的很喜欢' }, { en: noun, zh: like[1].trim() }],
      tips_zh: `“喜欢”后面直接接名词，例如 I really like ${noun}。`,
      unmatched: false,
    };
  }
  const want = original_zh.match(/(?:想要|我要|给我来|来)(?:喝|吃)?(?:一?杯|一)?(.{1,6}?)(?:[，。,.！!？?]|$)/);
  if (want && CN_WANT_MAP[want[1].trim()]) {
    const thing = CN_WANT_MAP[want[1].trim()];
    const isAction = thing.startsWith('to ');
    return {
      original_zh,
      english: isAction ? `I want ${thing}.` : `I'd like ${thing}, please.`,
      chunks: [{ en: isAction ? 'I want' : "I'd like", zh: isAction ? '我想要' : '我想要（礼貌）' }, { en: thing, zh: want[1].trim() }],
      tips_zh: isAction ? 'want 后面接 to do，例如 I want to rest。' : "点单用 I'd like … , please. 更礼貌。",
      unmatched: false,
    };
  }

  // 同时命中“求助元话语”和具体内容时，优先翻译具体内容（如“我今天很累，不知道怎么说”→ 教 I'm exhausted today.）
  const matches = CN_HELP_RULES.filter((rule) => rule.re.test(original_zh));
  const chosen = matches.find((rule) => !rule.meta) || matches[0];
  if (chosen) {
    return { original_zh, english: chosen.en, chunks: chosen.chunks || [], tips_zh: chosen.tips || '', unmatched: false };
  }
  return {
    original_zh,
    english: "What I'm trying to say is ...",
    chunks: [
      { en: "What I'm trying to say is", zh: '我想说的是' },
      { en: '...', zh: '（再用简单英文把意思补完整）' },
    ],
    tips_zh: CN_FALLBACK_TIPS,
    unmatched: true,
  };
}

/** 常见英文问题的直接回答（demo 模式，避免答非所问） */
const QUICK_ANSWER_RULES = [
  {
    re: /how are you|how's it going|how do you do|how have you been/i,
    replies: ["I'm doing really well, thanks for asking! A bit busy today, but I can't complain. How about you?"],
  },
  {
    re: /what'?s your name|who are you/i,
    replies: ["I'm Ava — your English teacher and chat buddy. What should I call you?"],
  },
  {
    re: /where are you from|where do you live|where were you born/i,
    replies: ["I'm from a small town near Boston, but these days I live inside your computer 😄 Where are you from?"],
  },
  {
    re: /how old are you|what'?s your age/i,
    replies: ["Old enough to have taught a lot of English classes 😄 I'd rather hear about you — what do you do?"],
  },
  {
    re: /do you like|what'?s your favorite|what is your favorite/i,
    replies: [
      "I do, actually — I'm pretty into it! I'd love to hear why you like it too. What do you like most about it?",
      "That's a fun question. My taste changes all the time, honestly. What about you — what's your favorite?",
    ],
  },
  {
    re: /what do you do|what'?s your job|are you a teacher/i,
    replies: ['I teach English and chat with learners like you all day — best job ever. What do you do?'],
  },
  {
    re: /can you help me|help me with (my )?english|teach me/i,
    replies: ["Of course — that's exactly what I'm here for. Let's start easy: what do you want to practice today?"],
  },
  {
    re: /do you speak chinese|会中文|会说中文/i,
    replies: ["Only a little! I try to answer in English so you get practice. If you get stuck, just ask me in Chinese and I'll help."],
  },
  {
    re: /what are you doing|what are you up to/i,
    replies: ["I'm having a cup of tea and waiting for you to tell me about your day. What are you up to?"],
  },
  {
    re: /are you (a )?(robot|ai|real|human|person)/i,
    replies: ["I'm a digital teacher — a friendly one, I hope 😄 My English is real, though. What would you like to talk about?"],
  },
  {
    re: /weather|is it (cold|hot|raining|sunny)/i,
    replies: ["I don't have a window here, so I can't check — what's the weather like where you are?"],
  },
  {
    re: /what time is it|what'?s the time/i,
    replies: ["I'm not sure — time works differently in my little digital world 😄 What time is it where you are?"],
  },
  {
    re: /tell me about yourself|introduce yourself/i,
    replies: ["I'm Ava: English teacher, coffee lover, and a good listener. I love hearing about people's days. What about you?"],
  },
  {
    re: /do you have (any )?(hobbies|hobby)|what do you do in your free time/i,
    replies: ["I like reading and walking around the city, and I never get tired of hearing people's stories. What about you?"],
  },
  {
    re: /what should i do|give me (some )?advice|any advice/i,
    replies: ["My honest advice: start small and do it every day — even five minutes of English. What are you trying to improve right now?"],
  },
];

const QUESTION_FALLBACK_REPLIES = [
  "That's a good question, honestly. Let me think — I'd say it depends on the person. What do you think?",
  "Hmm, good question. I don't have a perfect answer, but my honest take is: it's worth trying and seeing how it feels. What's your view?",
  "I'm glad you asked. I don't want to give you a boring answer, so tell me a little more — why are you curious about that?",
  "That's interesting to think about. My short answer is 'it depends', but I'd love to hear your opinion first.",
];

function isQuestion(text) {
  const t = String(text || '').trim();
  return /\?\s*$/.test(t) || /^(what|why|how|when|where|who|which|whose|do|does|did|are|is|am|can|could|would|should|have|has|will|shall|may)\b/i.test(t);
}

/** 引用用户原话（最多 9 个词） */
function quoteUser(text, maxWords = 9) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return '';
  const quote = words.slice(0, maxWords).join(' ').replace(/[.,!?;:]+$/, '');
  return quote.length > 2 ? quote : '';
}

/** free 模式：按用户消息关键词选择朋友式回复 */
export function buildDemoFreeReply(message, turn = 0) {
  const text = String(message || '').trim();
  const seed = `${text}|${turn}`;
  if (!text) return pick(FREE_FALLBACK_REPLIES, seed);

  // 1) 常见问题：直接给出真实回答，不答非所问
  for (const rule of QUICK_ANSWER_RULES) {
    if (rule.re.test(text)) return pick(rule.replies, seed);
  }
  // 2) 其它问题：承认问题、给出真实立场（不装作听懂，也不乱夸）
  if (isQuestion(text)) return pick(QUESTION_FALLBACK_REPLIES, seed);
  // 3) 陈述：先引用用户原话再承接，避免自顾自换话题
  const quote = quoteUser(text);
  let base = '';
  for (const rule of FREE_REPLY_RULES) {
    if (rule.re.test(text)) {
      base = pick(rule.replies, seed);
      break;
    }
  }
  if (!base) {
    base = text.split(/\s+/).filter(Boolean).length <= 3 ? pick(FREE_SHORT_REPLIES, seed) : pick(FREE_FALLBACK_REPLIES, seed);
  }
  if (quote) return `So you said "${quote}". ${base}`;
  return base;
}

/** 根据消息内容挑一个最相关的单词主题（演示模式反馈用） */
function demoVocabTopicFor(message) {
  const text = String(message || '');
  for (const rule of TOPIC_RULES) {
    if (rule.vocab && rule.re.test(text)) return rule.vocab;
  }
  return 'actions';
}

/* ---------------- 对话总结（演示模式规则版） ---------------- */

const TOPIC_RULES = [
  { re: /\b(work|job|office|boss|meeting|deadline|colleague|project|salary|career|overtime)\b/i, label: '工作', vocab: 'work' },
  { re: /\b(study|exam|school|class|homework|teacher|university|course|test|learn|learning)\b/i, label: '学习', vocab: 'work' },
  { re: /\b(travel|trip|flight|airport|holiday|vacation|beach|hotel|visit|abroad)\b/i, label: '旅行', vocab: 'travel' },
  { re: /\b(food|eat|restaurant|cook|cooking|dinner|lunch|breakfast|delicious|spicy|coffee|tea|latte)\b/i, label: '美食', vocab: 'food' },
  { re: /\b(movie|film|series|show|watch|netflix|drama|actor|episode)\b/i, label: '电影和剧', vocab: 'actions' },
  { re: /\b(hobby|sport|run|running|gym|game|gaming|music|guitar|piano|read|reading|draw|hiking|photography)\b/i, label: '兴趣爱好', vocab: 'actions' },
  { re: /\b(weekend|plan|tomorrow|next week|future|schedule|going to)\b/i, label: '周末和计划', vocab: 'actions' },
  { re: /\b(friend|family|mom|mother|dad|father|brother|sister|partner|girlfriend|boyfriend|parents)\b/i, label: '家人和朋友', vocab: 'feelings' },
  { re: /\b(tired|exhausted|stress|stressed|overwhelmed|sleepy|nervous|worried|sad|upset|angry|annoyed)\b/i, label: '情绪和压力', vocab: 'feelings' },
  { re: /\b(happy|excited|glad|great|awesome|amazing|fun|proud|grateful)\b/i, label: '开心的事', vocab: 'feelings' },
  { re: /\b(weather|rain|raining|sunny|cold|hot|windy|snow|cloudy)\b/i, label: '天气', vocab: 'actions' },
  { re: /\b(money|buy|shopping|expensive|cheap|price|save|budget)\b/i, label: '消费和购物', vocab: 'actions' },
];

/** 识别对话里聊到的中文话题（最多 3 个） */
export function detectConversationTopics(messages = []) {
  const text = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => m.content)
    .join(' ');
  const labels = [];
  for (const rule of TOPIC_RULES) {
    if (labels.length >= 3) break;
    if (rule.re.test(text) && !labels.includes(rule.label)) labels.push(rule.label);
  }
  return labels.length ? labels : ['日常聊天'];
}

/** 演示模式的总结词条：优先对话里出现过的词，再补话题高频词 */
function pickDemoKeyWords(text, topics) {
  const pools = [];
  for (const label of topics) {
    const rule = TOPIC_RULES.find((r) => r.label === label);
    if (rule?.vocab) pools.push(vocabFor(rule.vocab));
  }
  pools.push(vocabFor('actions'), vocabFor('feelings'));
  for (const topic of vocabTopics) pools.push(topic.words);
  const candidates = [];
  for (const pool of pools) {
    for (const w of pool) {
      if (!candidates.some((c) => c.word === w.word)) candidates.push(w);
    }
  }
  const lower = String(text || '').toLowerCase();
  const appeared = candidates.filter((w) => lower.includes(w.word.toLowerCase()));
  const rest = candidates.filter((w) => !appeared.includes(w));
  const chosen = [...appeared, ...rest].slice(0, 5);
  const why = ['对话里出现过，值得巩固', '这个话题的高频词', '日常交流常用表达'];
  return chosen.map((w, i) => ({
    word: w.word,
    phonetic: w.phonetic,
    meaning: w.meaning,
    example: w.example,
    why_zh: why[i % why.length],
  }));
}

/**
 * 演示模式对话总结：无 Key 时也能给出完整的总结 + 重点词 + 纠错。
 * @param {{role:string,content:string}[]} messages
 */

/** 从对话里提炼可复用的句型（demo/兜底用）。 */
function buildDemoPatterns(messages = []) {
  const text = (Array.isArray(messages) ? messages : []).map((m) => (m && m.content) || '').join(' ').toLowerCase();
  const all = [
    { re: /what do you (think|like)/, pattern: 'What do you think of …?', meaning: '你觉得……怎么样？', example: 'What do you think of this painting?', usage_zh: '询问看法，比 Do you like it? 更自然。' },
    { re: /\b(i|we) went\b/, pattern: 'I went to … and …', meaning: '我去了……并且……', example: 'I went to a gallery and saw a painting.', usage_zh: '用过去式讲今天发生的事情。' },
    { re: /\bsounds?\b/, pattern: 'That sounds + 形容词', meaning: '那听起来……', example: 'That sounds lovely.', usage_zh: '回应对方时比 very good 更地道。' },
    { re: /\bbecause\b/, pattern: '… because …', meaning: '……因为……', example: 'I like it because the light is beautiful.', usage_zh: '补充理由，让回答更完整。' },
    { re: /would like|'d like/, pattern: "I'd like to …", meaning: '我想要……', example: "I'd like to visit again.", usage_zh: '礼貌表达愿望。' },
    { re: /how do you/, pattern: 'How do you …?', meaning: '你怎样……？', example: 'How do you say this in English?', usage_zh: '不会表达时主动求助。' },
    { re: /what about/, pattern: 'What about …?', meaning: '……呢？', example: 'What about the colours?', usage_zh: '把话题抛回给对方。' },
  ];
  const picked = all.filter((p) => p.re.test(text)).map(({ re, ...rest }) => rest);
  const fallback = [
    { pattern: 'Could you tell me more about …?', meaning: '可以多告诉我一些关于……的事吗？', example: 'Could you tell me more about the painting?', usage_zh: '让对话继续下去。' },
    { pattern: "I'd like to …", meaning: '我想要……', example: "I'd like to talk about my day.", usage_zh: '表达想做的事。' },
    { pattern: 'That sounds + 形容词', meaning: '那听起来……', example: 'That sounds interesting.', usage_zh: '自然回应对方。' },
  ];
  for (const item of fallback) {
    if (picked.length >= 3) break;
    if (!picked.some((p) => p.pattern === item.pattern)) picked.push(item);
  }
  return picked.slice(0, 4);
}
export function buildDemoSummary(messages = [], { teacherName = 'Ava', level = 'A2' } = {}) {
  const msgs = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'),
  );
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const chineseTurns = userMsgs.filter((m) => detectChinese(m.content)).length;
  const text = msgs.map((m) => m.content).join(' ');
  const topics = detectConversationTopics(msgs);
  const corrections = detectCorrections(userMsgs.map((m) => m.content).join(' . ')).slice(0, 3);
  const keyWords = pickDemoKeyWords(text, topics);
  const turns = userMsgs.length;
  const totalWords = userMsgs.reduce((n, m) => n + m.content.split(/\s+/).filter(Boolean).length, 0);
  const avg = turns ? Math.round(totalWords / turns) : 0;

  const strengths = [];
  if (turns >= 2) strengths.push(`连续聊了 ${turns} 轮，用英文交流的意愿很强`);
  if (avg >= 8) strengths.push('句子信息量不错，能主动补充细节');
  else if (avg >= 4) strengths.push('能用完整句子表达想法');
  if (!corrections.length) strengths.push('表达准确，这次没有明显语法错误');
  else strengths.push('愿意尝试更复杂的表达，纠错点很有价值');

  const improvements = corrections.slice(0, 2).map((c) => `注意：${c.explanation_zh}`);
  if (improvements.length < 2) {
    improvements.push('下次可以多用连接词（because / actually / to be honest）让表达更连贯');
  }
  if (chineseTurns > 0) {
    strengths.unshift('不会表达时会主动用中文求助，学习策略很成熟');
    improvements.unshift('遇到不会说的句子可以先问 "How do you say … in English?"，再试着自己用简单英文说');
  }

  const summary = `这次你和 ${teacherName} 聊到了${topics.join('、')}，一共说了 ${turns} 句英文，平均每句 ${avg} 个词。${
    corrections.length ? '整体交流很顺畅，有几个小地方可以更地道。' : '表达准确、交流顺畅。'
  }${chineseTurns > 0 ? '遇到不会说的地方你主动用中文求助，这是很好的学习习惯；把学会的英文表达再读一遍会记得更牢。' : ''}继续保持开口说的习惯，下次试着多讲一点细节。`;

  return {
    demo: true,
    summary_zh: summary,
    topics_zh: topics,
    strengths_zh: strengths.slice(0, 2),
    improvements_zh: improvements.slice(0, 2),
    corrections,
    keyPatterns: buildDemoPatterns(msgs),
    keyWords,
    encouragement_zh: pick(ENCOURAGEMENTS, `${text}|${topics.join()}`),
  };
}

/** 简易错误规则：正则 → 纠错信息 */
const ERROR_RULES = [
  {
    re: /\bi\s+very\s+(like|love|want|enjoy)\b/i,
    fix: (m) => `I really ${m[1].toLowerCase()}`,
    explanation_zh: 'very 不能直接修饰动词，要用 really / very much。',
  },
  {
    re: /\bi\s+am\s+agree\b/i,
    fix: () => 'I agree',
    explanation_zh: 'agree 本身就是动词，直接说 I agree，不用 be 动词。',
  },
  {
    re: /\bhow\s+to\s+say\b/i,
    fix: () => 'How do you say ... in English?',
    explanation_zh: '提问要用助动词：How do you say ...?',
  },
  {
    re: /\b(he|she|it)\s+don't\b/i,
    fix: (m) => `${m[1]} doesn't`,
    explanation_zh: '第三人称单数要用 doesn\'t，动词也用原形。',
  },
  {
    re: /\bi\s+have\s+(went|saw|ate|did|bought)\b/i,
    fix: (m) => `I ${m[1]}`,
    explanation_zh: '现在完成时用过去分词，但简单叙述过去发生的事直接用过去式即可。',
  },
  {
    re: /\bmore\s+(better|easier|cheaper)\b/i,
    fix: (m) => `${m[1]}`,
    explanation_zh: '比较级 already 含“更”的意思，不要再加 more。',
  },
  {
    re: /\bi\s+(go|eat|see|buy|watch)\s+(yesterday|last\s+night|last\s+week)\b/i,
    fix: (m) => `I went / ate / saw / bought (过去式) ${m[2].toLowerCase()}`,
    explanation_zh: '描述过去发生的事，动词要用过去式。',
  },
  {
    re: /\bi\s+am\s+boring\b/i,
    fix: () => 'I am bored',
    explanation_zh: 'boring 修饰事物（无聊的），形容自己的感受用 bored（感到无聊）。',
  },
  {
    re: /\bpeoples\b/i,
    fix: () => 'people',
    explanation_zh: 'people 本身已是复数，不加 s。',
  },
  {
    re: /\bi\s+want\s+go\b/i,
    fix: () => 'I want to go',
    explanation_zh: 'want 后面接不定式 to do。',
  },
];

function hash(str) {
  let h = 0;
  for (let i = 0; i < String(str || '').length; i++) h = (h * 31 + String(str).charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick(arr, seed) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr[hash(seed) % arr.length];
}

function vocabFor(topicId) {
  const topic = vocabTopics.find((t) => t.id === topicId) || vocabTopics[0];
  return topic.words;
}

/** 根据学生消息生成规则纠错（无 LLM 时） */
export function detectCorrections(message) {
  const corrections = [];
  const text = String(message || '');
  for (const rule of ERROR_RULES) {
    if (corrections.length >= 2) break;
    const m = text.match(rule.re);
    if (m) {
      corrections.push({
        original: m[0],
        corrected: rule.fix(m),
        explanation_zh: rule.explanation_zh,
      });
    }
  }
  return corrections;
}

/** 从英文句中找 1–2 个词库词，作为中文求助的生词推荐 */
function findVocabInEnglish(english, limit = 2) {
  const text = String(english || '').toLowerCase();
  const out = [];
  for (const topic of vocabTopics) {
    for (const w of topic.words) {
      if (out.length >= limit) break;
      if (text.includes(w.word.toLowerCase()) && !out.some((o) => o.word === w.word)) {
        out.push({ word: w.word, phonetic: w.phonetic, meaning: w.meaning, example: w.example });
      }
    }
  }
  return out;
}

/** 中文求助的演示回复：先理解，再教英文表达 */
function buildDemoChineseReply({ message, mode = 'free', topicId = 'daily', scenarioId = 'coffee', history = [], focusWords = [] }) {
  const chineseHelp = buildChineseHelp(message);
  const feedback = buildDemoFeedback({ message, topicId, scenarioId, history, extraWords: focusWords, mode, chineseHelp });
  const text = chineseHelp.unmatched
    ? `No worries — asking in Chinese is completely fine. In English, start with: "What I'm trying to say is …" and then explain in simple words. Let's practice that pattern together.`
    : `No worries — in English you can say: "${chineseHelp.english}" Let's try it together.`;
  return { text, feedback };
}

function buildDemoFeedback({ message, topicId, scenarioId, history = [], extraWords = [], mode = 'free', chineseHelp = null }) {
  if (chineseHelp) {
    return {
      corrections: [],
      better: [],
      newWords: findVocabInEnglish(chineseHelp.english),
      encouragement_zh: '这句英文表达已经给你了，点「跟我读」念一遍会记得更牢。',
      followUp: '',
      chineseHelp,
    };
  }
  const corrections = detectCorrections(message);
  const words = vocabFor(SCENARIO_TOPIC[scenarioId] || topicId);
  const focus = extraWords.length ? extraWords : words;
  const seed = `${message}|${history.length}|${topicId}|${scenarioId}`;
  const start = hash(seed) % Math.max(1, focus.length);
  const newWords = [];
  for (let i = 0; i < 2 && focus.length; i++) {
    const w = focus[(start + i) % focus.length];
    if (!w) continue;
    if (newWords.some((n) => n.word === w.word)) continue;
    newWords.push({ word: w.word, phonetic: w.phonetic, meaning: w.meaning, example: w.example });
  }
  const better = [];
  if (/\bi\s+like\s+it\s+very\s+much\b/i.test(message) && corrections.length < 2) {
    better.push({ original: 'I like it very much', better: "I'm really into it", why_zh: '更地道、更口语化的表达。' });
  }
  return {
    corrections,
    better,
    newWords,
    encouragement_zh:
      mode === 'free'
        ? corrections.length
          ? '我帮你把这两处改得更自然了，读一遍试试。'
          : String(message || '').trim().split(/\s+/).filter(Boolean).length >= 8
            ? '这句信息量很足，继续多讲一点细节会更自然。'
            : '能主动开口就是进步，下次试着多说一个细节。'
        : pick(ENCOURAGEMENTS, seed),
    followUp: '',
    chineseHelp: null,
  };
}

/**
 * 生成演示回复。
 * @returns {{text:string, feedback:object}}
 */
export function buildDemoReply({ mode = 'free', topicId = 'daily', scenarioId = 'coffee', message = '', history = [], focusWords = [] } = {}) {
  const turn = (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user').length;
  if (detectChinese(message)) {
    return buildDemoChineseReply({ message, mode, topicId, scenarioId, history, focusWords });
  }
  let text = '';

  if (mode === 'roleplay') {
    const lines = ROLEPLAY_LINES[scenarioId] || ROLEPLAY_LINES.coffee;
    text = lines[Math.min(turn, lines.length - 1)];
  } else if (mode === 'vocab') {
    const words = focusWords.length ? vocabFor(topicId).filter((w) => focusWords.includes(w.word)) : vocabFor(topicId);
    const word = words[turn % Math.max(1, words.length)] || vocabFor(topicId)[0];
    const kind = turn % 3;
    if (kind === 0) {
      text = `Nice work! "${word.word}" means ${word.meaning}. Can you say: ${word.example}`;
    } else if (kind === 1) {
      text = `Good try! Now make your own sentence with "${word.word}", please. For example: ${word.example}`;
    } else {
      text = `Great job! Quick quiz: what does "${word.word}" mean in Chinese? Try to answer in English first.`;
    }
  } else if (mode === 'pronounce') {
    const bank = [
      'I would like a cup of coffee.',
      'Could you say that again, please?',
      'I am looking forward to seeing you.',
      'The weather is really nice today.',
    ];
    const sentence = pick(bank, `${message}|${turn}`);
    text = `Good effort! Now repeat after me: ${sentence}`;
  } else {
    text = buildDemoFreeReply(message, turn);
  }

  const feedback = buildDemoFeedback({ message, topicId: mode === 'free' ? demoVocabTopicFor(message) : topicId, scenarioId, history, extraWords: focusWords, mode });
  if (mode === 'roleplay') {
    const scenario = roleplayScenarios.find((s) => s.id === scenarioId);
    feedback.followUp = scenario ? '' : '';
  }
  return { text, feedback };
}

/** 演示模式下的开场白 */
export function buildDemoOpener({ mode = 'free', topicId = 'daily', scenarioId = 'coffee' } = {}) {
  if (mode === 'roleplay') {
    const scenario = roleplayScenarios.find((s) => s.id === scenarioId) || roleplayScenarios[0];
    return scenario.opener;
  }
  return pick(freeOpeners, `${mode}|${Date.now()}|${Math.random()}`);
}
