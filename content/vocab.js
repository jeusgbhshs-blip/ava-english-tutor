/**
 * 单词库：按主题分组，供「单词闯关」和生词复习使用。
 * phonetic 为美式/英式折中音标（教学用，不必严格到方言级）。
 */

export const vocabTopics = [
  {
    id: 'cafe',
    emoji: '☕',
    name: '咖啡店 & 餐厅',
    level: 'A2',
    words: [
      { word: 'latte', phonetic: '/ˈlɑːteɪ/', meaning: '拿铁咖啡', example: "I'd like a medium latte, please.", exampleZh: '我要一杯中杯拿铁。' },
      { word: 'espresso', phonetic: '/eˈspresəʊ/', meaning: '浓缩咖啡', example: 'One espresso, no sugar.', exampleZh: '一杯浓缩，不加糖。' },
      { word: 'cappuccino', phonetic: '/ˌkæpʊˈtʃiːnəʊ/', meaning: '卡布奇诺', example: 'This cappuccino has beautiful foam.', exampleZh: '这杯卡布奇诺奶泡很漂亮。' },
      { word: 'croissant', phonetic: '/ˈkwæsɒ̃/', meaning: '可颂 / 牛角包', example: 'Would you like a croissant with that?', exampleZh: '需要配一个可颂吗？' },
      { word: 'takeaway', phonetic: '/ˈteɪkəweɪ/', meaning: '外带（餐）', example: 'Is this for here or takeaway?', exampleZh: '在这里吃还是外带？' },
      { word: 'receipt', phonetic: '/rɪˈsiːt/', meaning: '收据', example: 'Could I have the receipt, please?', exampleZh: '可以给我收据吗？' },
      { word: 'refill', phonetic: '/ˈriːfɪl/', meaning: '续杯；再装满', example: 'Can I get a refill on my coffee?', exampleZh: '我的咖啡可以续杯吗？' },
      { word: 'tip', phonetic: '/tɪp/', meaning: '小费；提示', example: 'We usually leave a tip for good service.', exampleZh: '服务好我们通常会给小费。' },
    ],
  },
  {
    id: 'travel',
    emoji: '✈️',
    name: '旅行 & 机场',
    level: 'A2',
    words: [
      { word: 'passport', phonetic: '/ˈpɑːspɔːt/', meaning: '护照', example: 'May I see your passport, please?', exampleZh: '可以看一下你的护照吗？' },
      { word: 'luggage', phonetic: '/ˈlʌɡɪdʒ/', meaning: '行李', example: 'How many pieces of luggage do you have?', exampleZh: '你有几件行李？' },
      { word: 'boarding pass', phonetic: '/ˈbɔːdɪŋ pɑːs/', meaning: '登机牌', example: 'Please keep your boarding pass ready.', exampleZh: '请准备好登机牌。' },
      { word: 'departure', phonetic: '/dɪˈpɑːtʃə/', meaning: '出发；离境', example: 'The departure time is nine thirty.', exampleZh: '起飞时间是九点半。' },
      { word: 'arrival', phonetic: '/əˈraɪvəl/', meaning: '到达', example: 'We will arrive at the arrival hall in ten minutes.', exampleZh: '我们将在十分钟后到达抵达大厅。' },
      { word: 'delayed', phonetic: '/dɪˈleɪd/', meaning: '延误的', example: 'My flight is delayed by two hours.', exampleZh: '我的航班延误了两小时。' },
      { word: 'aisle', phonetic: '/aɪl/', meaning: '过道', example: 'I would prefer an aisle seat.', exampleZh: '我更想要靠过道的座位。' },
      { word: 'customs', phonetic: '/ˈkʌstəmz/', meaning: '海关', example: 'You need to go through customs first.', exampleZh: '你需要先过海关。' },
    ],
  },
  {
    id: 'work',
    emoji: '💼',
    name: '求职 & 职场',
    level: 'B1',
    words: [
      { word: 'interview', phonetic: '/ˈɪntəvjuː/', meaning: '面试', example: 'I have a job interview tomorrow morning.', exampleZh: '我明天上午有一场面试。' },
      { word: 'resume', phonetic: '/ˈrezəmeɪ/', meaning: '简历', example: 'Could you send me your resume?', exampleZh: '你能把简历发给我吗？' },
      { word: 'salary', phonetic: '/ˈsæləri/', meaning: '薪水', example: 'The salary is negotiable for the right person.', exampleZh: '合适的人薪水可以谈。' },
      { word: 'deadline', phonetic: '/ˈdedlaɪn/', meaning: '截止日期', example: 'We need to meet the deadline this Friday.', exampleZh: '我们得在本周五前完成。' },
      { word: 'colleague', phonetic: '/ˈkɒliːɡ/', meaning: '同事', example: 'My colleague helped me a lot.', exampleZh: '我的同事帮了我很多。' },
      { word: 'feedback', phonetic: '/ˈfiːdbæk/', meaning: '反馈', example: 'Thank you for your honest feedback.', exampleZh: '谢谢你坦诚的反馈。' },
      { word: 'promotion', phonetic: '/prəˈməʊʃn/', meaning: '晋升', example: 'She got a promotion last month.', exampleZh: '她上个月升职了。' },
      { word: 'negotiate', phonetic: '/nɪˈɡəʊʃieɪt/', meaning: '谈判；协商', example: 'We can negotiate the start date.', exampleZh: '入职时间可以商量。' },
    ],
  },
  {
    id: 'feelings',
    emoji: '😊',
    name: '情绪 & 形容词',
    level: 'A2',
    words: [
      { word: 'excited', phonetic: '/ɪkˈsaɪtɪd/', meaning: '兴奋的', example: 'I am excited about the trip.', exampleZh: '我对这次旅行很兴奋。' },
      { word: 'nervous', phonetic: '/ˈnɜːvəs/', meaning: '紧张的', example: 'I feel nervous before speaking English.', exampleZh: '说英语前我会紧张。' },
      { word: 'grateful', phonetic: '/ˈɡreɪtfəl/', meaning: '感激的', example: 'I am grateful for your help.', exampleZh: '我很感激你的帮助。' },
      { word: 'confident', phonetic: '/ˈkɒnfɪdənt/', meaning: '自信的', example: 'Practice makes you more confident.', exampleZh: '练习会让你更自信。' },
      { word: 'frustrated', phonetic: '/frʌˈstreɪtɪd/', meaning: '沮丧的；受挫的', example: 'He felt frustrated when he could not remember the word.', exampleZh: '他想不起那个词时很沮丧。' },
      { word: 'curious', phonetic: '/ˈkjʊəriəs/', meaning: '好奇的', example: 'She is curious about other cultures.', exampleZh: '她对其他文化很好奇。' },
      { word: 'relaxed', phonetic: '/rɪˈlækst/', meaning: '放松的', example: 'I feel relaxed after a walk.', exampleZh: '散步后我感到很放松。' },
      { word: 'embarrassed', phonetic: '/ɪmˈbærəst/', meaning: '尴尬的', example: "Don't be embarrassed to make mistakes.", exampleZh: '不要因为犯错而尴尬。' },
    ],
  },
  {
    id: 'actions',
    emoji: '🏃',
    name: '高频动词短语',
    level: 'A2',
    words: [
      { word: 'hang out', phonetic: '/hæŋ aʊt/', meaning: '闲逛；一起玩', example: 'Do you want to hang out this weekend?', exampleZh: '这周末想一起玩吗？' },
      { word: 'work out', phonetic: '/wɜːk aʊt/', meaning: '锻炼；解决', example: 'I work out three times a week.', exampleZh: '我一周锻炼三次。' },
      { word: 'catch up', phonetic: '/kætʃ ʌp/', meaning: '叙旧；赶上', example: 'Let us catch up over coffee.', exampleZh: '我们边喝咖啡边聊近况吧。' },
      { word: 'figure out', phonetic: '/ˈfɪɡə aʊt/', meaning: '弄明白；想出', example: 'I finally figured out the answer.', exampleZh: '我终于想明白答案了。' },
      { word: 'run errands', phonetic: '/rʌn ˈerəndz/', meaning: '办事；跑腿', example: 'I need to run some errands this afternoon.', exampleZh: '我下午要去办点事。' },
      { word: 'look forward to', phonetic: '/lʊk ˈfɔːwəd tuː/', meaning: '期待', example: 'I look forward to hearing from you.', exampleZh: '我期待你的消息。' },
      { word: 'turn down', phonetic: '/tɜːn daʊn/', meaning: '拒绝；调低', example: 'She turned down the offer politely.', exampleZh: '她礼貌地拒绝了那个提议。' },
      { word: 'give up', phonetic: '/ɡɪv ʌp/', meaning: '放弃', example: 'Never give up on learning English.', exampleZh: '学英语永远不要放弃。' },
    ],
  },
  {
    id: 'food',
    emoji: '🍜',
    name: '美食 & 口味',
    level: 'A2',
    words: [
      { word: 'delicious', phonetic: '/dɪˈlɪʃəs/', meaning: '美味的', example: 'This noodle soup is delicious.', exampleZh: '这碗面汤很美味。' },
      { word: 'spicy', phonetic: '/ˈspaɪsi/', meaning: '辣的', example: 'I love spicy food, especially hot pot.', exampleZh: '我喜欢吃辣，尤其是火锅。' },
      { word: 'salty', phonetic: '/ˈsɔːlti/', meaning: '咸的', example: 'The soup is a little too salty.', exampleZh: '这汤有点太咸了。' },
      { word: 'sour', phonetic: '/ˈsaʊə/', meaning: '酸的', example: 'The lemon tastes very sour.', exampleZh: '这个柠檬很酸。' },
      { word: 'crispy', phonetic: '/ˈkrɪspi/', meaning: '酥脆的', example: 'I like crispy fried chicken.', exampleZh: '我喜欢酥脆的炸鸡。' },
      { word: 'flavor', phonetic: '/ˈfleɪvə/', meaning: '味道；口味', example: 'Which flavor would you like?', exampleZh: '你想要哪种口味？' },
      { word: 'ingredient', phonetic: '/ɪnˈɡriːdiənt/', meaning: '配料；食材', example: 'Fresh ingredients make a big difference.', exampleZh: '新鲜食材影响很大。' },
      { word: 'recipe', phonetic: '/ˈresəpi/', meaning: '食谱；做法', example: 'Could you share the recipe with me?', exampleZh: '能把做法分享给我吗？' },
    ],
  },
];

/** 按 id 取主题 */
export function getVocabTopic(id) {
  return vocabTopics.find((t) => t.id === id) || vocabTopics[0];
}
