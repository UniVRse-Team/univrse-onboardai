import { AIMessage } from '@langchain/core/messages';

// Stand-ins for Gemini and the company document search in the local preview, so
// Alya answers the question that was asked from sample handbook facts instead of
// one fixed reply. Real answers come from the approved company documents.
const passages = [
  {
    title: 'Employee Handbook (sample)',
    heading: 'Dress code',
    keywords: [
      'wear',
      'dress',
      'cloth',
      'attire',
      'jeans',
      'shirt',
      'slipper',
      'shorts',
      'pakaian',
    ],
    text: 'Dress smart casual in the office. Ripped jeans, short pants, T-shirts and slippers are restricted on weekdays. If you are unsure about an outfit, ask your manager or HR.',
  },
  {
    title: 'Employee Handbook (sample)',
    heading: 'Working hours',
    keywords: ['hour', 'time', 'start', 'finish', 'lunch', 'break', 'work', 'masa', 'waktu'],
    text: 'Normal working hours from Monday to Thursday are 9:00 to 12:30 and 1:30 to 5:30. There is a regular internal meeting on Friday morning at 9:30.',
  },
  {
    title: 'Business Conduct Policy (sample)',
    heading: 'Meetings',
    keywords: ['meeting', 'agenda', 'friday', 'mesyuarat', 'minutes', 'action'],
    text: 'For meetings, agree an agenda, arrive five minutes early, and record decisions and action items with owners and due dates. The regular internal meeting is on Friday at 9:30 a.m.',
  },
  {
    title: 'Employee Handbook (sample)',
    heading: 'Conduct and device safety',
    keywords: [
      'password',
      'email',
      'phishing',
      'laptop',
      'lost',
      'stolen',
      'suspicious',
      'safe',
      'it',
    ],
    text: 'Never share your password, not even with IT, because IT will never ask for it. Forward suspicious emails to IT without clicking their links, and report a lost or stolen laptop to IT within 2 hours.',
  },
  {
    title: 'Employee Handbook (sample)',
    heading: 'Privacy and data',
    keywords: ['data', 'privacy', 'customer', 'confidential', 'pdpa', 'personal'],
    text: 'Customer data, prices, source code and business plans are confidential, during and after your employment. Use customer data only to do your job, and never copy it to a personal device or account.',
  },
  {
    title: 'Employee Handbook (sample)',
    heading: 'Responsible AI use',
    keywords: ['ai', 'gemini', 'chatgpt', 'tool', 'paste'],
    text: 'Use only approved AI tools, such as Alya and Gemini in your company account. Never paste customer data, payslips or source code into an AI tool that IT has not approved.',
  },
  {
    title: 'Company Overview (sample)',
    heading: 'Vision, mission and values',
    keywords: ['vision', 'mission', 'value', 'company', 'about', 'overview', 'syarikat'],
    text: 'Our vision is to positively impact 1 billion people’s lives through technology, creativity and innovation. Our mission is to enhance people’s lives through IT and build a globally recognised brand. The core values are value driven, be happy, be trustworthy, elegant solution, evolve in learning, spread positivity and teamwork.',
  },
];

const words = (text) =>
  String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
const score = (passage, question) => {
  const asked = words(question);
  return passage.keywords.filter((key) => asked.some((word) => word.startsWith(key))).length;
};
const lastQuestion = (messages) => {
  const human = [...messages].reverse().find((m) => m._getType?.() === 'human');
  const content = human?.content;
  return typeof content === 'string' ? content : '';
};
const best = (question) => {
  const ranked = passages
    .map((passage) => ({ passage, points: score(passage, question) }))
    .filter((item) => item.points > 0)
    .sort((a, b) => b.points - a.points);
  return ranked.slice(0, 1).map((item) => item.passage);
};

export const previewRetrieve = async (query) =>
  best(query).map(({ title, heading, text }) => ({ title, heading, text }));

export const previewModels = () => ({
  plan: {
    invoke: async (messages) => {
      const question = lastQuestion(messages);
      if (/^\s*(hi|hello|hai|salam|hey)\b/i.test(question))
        return { kind: 'conversation', query: question, clarification: '' };
      return { kind: 'company', query: question, clarification: '' };
    },
  },
  answer: {
    invoke: async (messages) => {
      const system = String(messages[0]?.content || '');
      const match = /Reference passages: (\[.*\])/s.exec(system);
      let found = [];
      try {
        found = JSON.parse(match?.[1] || '[]');
      } catch {
        found = [];
      }
      if (!found.length)
        return {
          answer: 'I could not find that in the sample guidance.',
          citations: [],
          coverage: 'none',
        };
      const top = found[0];
      return { answer: top.text, citations: [top.id], coverage: 'full' };
    },
  },
  summarize: { invoke: async () => new AIMessage('Earlier questions.') },
});
