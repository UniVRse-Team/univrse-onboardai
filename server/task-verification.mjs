import { ChatError } from './chat-errors.mjs';
import { journeyCollections } from './onboarding-collections.mjs';
import { driveLinks, handbookTitle } from './onboarding-content.mjs';

// Task verification content and storage for the four learning areas.
//
// Every fact below is taken from the approved onboarding plan
// (server/onboarding-content.mjs: its briefings and knowledge checks). Nothing
// here may add a policy, contact, date or tool state that the plan does not
// state. Content that is missing is named in `contentRequirements` instead.
// The quiz questions only ask what the matching briefing says; if HR edits a
// briefing, review the questions for that step.

export const DEFAULT_POLICY_PASSING_SCORE = 80;
const DEFAULT_ALIGNMENT_PASSING_SCORE = 100;

const passingScoreFrom = (name, env, fallback) => {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : fallback;
};
// Pass marks are server configuration, read per request; a client can never
// lower them. POLICY_QUIZ_PASSING_SCORE for policy quizzes and
// ALIGNMENT_CHECK_PASSING_SCORE for alignment knowledge checks (1-100).
export const policyPassingScore = (env = process.env) =>
  passingScoreFrom('POLICY_QUIZ_PASSING_SCORE', env, DEFAULT_POLICY_PASSING_SCORE);
export const alignmentPassingScore = (env = process.env) =>
  passingScoreFrom('ALIGNMENT_CHECK_PASSING_SCORE', env, DEFAULT_ALIGNMENT_PASSING_SCORE);

// Role/tool steps whose completion means "I was given access". They are proven
// by an authorised coordinator confirmation, never by a checkbox.
export const TOOL_ACCESS_STEP_IDS = Object.freeze([
  'role-tools.gsheet-account',
  'role-tools.individual-gsheet',
  'role-tools.drive-shared-folders',
  'role-tools.gmail-google-chat',
  'role-tools.professional-email',
]);

// Alignment steps proven by an activity (matching or quiz). Other alignment steps
// are confirmed by the employee like any self step.
export const ALIGNMENT_ACTIVITY_STEP_IDS = Object.freeze([
  'alignment.products-customers',
  'alignment.mission-values',
  'alignment.org-structure',
  'alignment.role-contribution',
]);

export const APPROVED_HANDBOOK_METADATA = Object.freeze({
  title: handbookTitle,
  publisher: 'Company',
  contentRequirementNotice:
    'Content requirement: the full Employee Handbook document has not been added to this deployment. The summaries shown come from your onboarding plan. HR should add the full handbook so employees can read the source document.',
});

// Missing content, shown to HR/employees instead of being invented.
export const CONTENT_REQUIREMENTS = Object.freeze([
  'Full Employee Handbook document and any separate privacy, data protection and responsible AI policy documents.',
  'Role-specific responsibilities and first-30-day goals for each role (the profile only holds title, department and manager).',
  'A directory of team contacts and support channels beyond IT (it-help@company.example) and the contacts HR enters for the first day.',
  'An integration or coordinator workflow to verify Google Workspace tool access automatically.',
]);

// Question builders. Types: single (one right option), multi (several right
// options, all required) and match (pair every statement with its choice).
const q = (id, prompt, options, correct, explanation, multiple = false) => ({
  id,
  type: multiple || (Array.isArray(correct) && correct.length > 1) ? 'multi' : 'single',
  prompt,
  multiple: multiple || (Array.isArray(correct) && correct.length > 1),
  options: options.map(([oid, text]) => ({ id: oid, text })),
  correct: Array.isArray(correct) ? correct : [correct],
  explanation,
});
const match = (id, prompt, pairs, choices, explanation) => ({
  id,
  type: 'match',
  prompt,
  pairs: pairs.map(([pid, text, correct]) => ({ id: pid, text, correct })),
  choices: choices.map(([cid, label]) => ({ id: cid, label })),
  explanation,
});

// Each question below is a situation answered by what the briefing for that
// step states; none relies on a rule the onboarding plan does not give.
export const APPROVED_POLICIES = Object.freeze({
  'policies.employee-handbook': {
    title: 'Employee Handbook: hours, conduct, claims and leave',
    sourceTitle: handbookTitle,
    document: { title: 'Employee Handbook', url: driveLinks.handbook },
    objectives: [
      'Know the working hours, the Friday meeting and the weekday dress code.',
      'Know how to report sickness, make claims and apply for leave.',
      'Know how to protect passwords and company information.',
    ],
    quiz: {
      questions: [
        q(
          'q1',
          'What are the normal working hours from Monday to Thursday?',
          [
            ['a', '8:00 a.m. to 5:00 p.m.'],
            ['b', '9:00 a.m. to 12:30 p.m. and 1:30 p.m. to 5:30 p.m.'],
            ['c', '10:00 a.m. to 6:00 p.m.'],
          ],
          'b',
          'Monday to Thursday: morning work 9:00 a.m. to 12:30 p.m., a lunch break to 1:30 p.m., then afternoon work to 5:30 p.m.',
        ),
        q(
          'q2',
          'When is the regular internal meeting?',
          [
            ['a', 'Every Monday at 10:00 a.m.'],
            ['b', 'Every Friday at 9:30 a.m.'],
            ['c', 'On the first day of each month'],
          ],
          'b',
          'The handbook records a regular internal meeting on Friday at 9:30 a.m.',
        ),
        q(
          'q3',
          'Which outfit fits the weekday dress code?',
          [
            ['a', 'Ripped jeans and a T-shirt'],
            ['b', 'Short pants and slippers'],
            ['c', 'Neat, smart-casual clothes'],
          ],
          'c',
          'The handbook describes smart-casual attire and restricts ripped jeans, short pants, T-shirts and slippers on weekdays. Business attire may be required for client meetings.',
        ),
        q(
          'q4',
          'You are unwell and cannot come to work. What should you do?',
          [
            ['a', 'Wait until you are back and explain then'],
            [
              'b',
              'Tell your supervisor or manager as soon as possible, preferably before the workday begins',
            ],
            ['c', 'Ask a colleague to tell no one'],
          ],
          'b',
          'Inform your immediate supervisor or manager as soon as possible, preferably before the workday begins.',
        ),
        q(
          'q5',
          'Within how long should a medical certificate normally be sent after sick leave starts, where practicable?',
          [
            ['a', 'Six hours'],
            ['b', 'Two weeks'],
            ['c', 'The end of the month'],
          ],
          'a',
          'Send the medical certificate to the manager or HR/Admin promptly, normally within six hours of the start of sick leave where practicable.',
        ),
        q(
          'q6',
          'How soon after an expense should a claim normally be submitted?',
          [
            ['a', 'Within 30 calendar days'],
            ['b', 'Within one year'],
            ['c', 'Only at the end of the financial year'],
          ],
          'a',
          'Submit the claim through the approved process within 30 calendar days of the expense, unless a different written deadline applies.',
        ),
        q(
          'q7',
          'An expense will be above RM500. What is needed?',
          [
            ['a', 'Nothing, if you keep the receipt'],
            ['b', 'Head of Department approval before the expense is incurred'],
            ['c', 'Split it into smaller claims'],
          ],
          'b',
          'Claims above RM500 need Head of Department approval before the expense is incurred. Never split an expense to avoid the threshold.',
        ),
        q(
          'q8',
          'How many days of annual leave do you have in your first year of employment?',
          [
            ['a', '12 days'],
            ['b', '16 days'],
            ['c', '22 days'],
          ],
          'a',
          'First year of employment: 12 days. It is earned pro-rata and tracked by calendar year.',
        ),
        q(
          'q9',
          'A colleague asks for your password to finish something quickly. What do you do?',
          [
            ['a', 'Share it, because they are a colleague'],
            ['b', 'Share it only by chat'],
            [
              'c',
              'Do not share it: never share passwords or authentication codes, even with colleagues',
            ],
          ],
          'c',
          'Use only your assigned account and do not share passwords or authentication codes, even with colleagues.',
        ),
        q(
          'q10',
          'You would like to work overtime this evening. What is right?',
          [
            [
              'a',
              'Overtime must be authorised in advance by your supervisor or designated manager',
            ],
            ['b', 'Staying late always creates an overtime payment'],
            ['c', 'No approval is ever needed'],
          ],
          'a',
          'Overtime must be authorised in advance, except where an urgent situation makes that impracticable. Staying late does not automatically create an entitlement.',
        ),
      ],
    },
  },
  'policies.workplace-conduct': {
    title: 'Workplace conduct & safe practices',
    sourceTitle: handbookTitle,
    objectives: [
      'Recognise behaviour that is not tolerated.',
      'Protect your password and respond correctly to suspicious emails and lost devices.',
    ],
    quiz: {
      questions: [
        q(
          'q1',
          'An email that says it is from IT asks you to reply with your password so your account can be “verified”. What should you do?',
          [
            ['a', 'Forward it to it-help@company.example without clicking its links'],
            ['b', 'Reply with your password so that IT can verify you'],
            ['c', 'Open the link in it to check that the request is real'],
          ],
          'a',
          'IT will never ask for your password. Forward suspicious emails to IT without clicking their links.',
        ),
        q(
          'q2',
          'Someone phones, says they are from IT, and asks for your password to fix a problem. What is right?',
          [
            ['a', 'Give it; they are from IT'],
            ['b', 'Do not share it: never share your password, not even with IT'],
            ['c', 'Give only half of it'],
          ],
          'b',
          'Never share your password, not even with IT, because IT will never ask for it.',
        ),
        q(
          'q3',
          'A colleague asks to borrow your password to finish an urgent report. What is right?',
          [
            ['a', 'Say no: never share your password'],
            ['b', 'Share it if they promise to change it'],
            ['c', 'Share it only for one hour'],
          ],
          'a',
          'Never share your password. IT will not ask for it, and neither should anyone else.',
        ),
        q(
          'q4',
          'An unexpected email with a link looks suspicious. What do you do?',
          [
            ['a', 'Click the link to check it'],
            ['b', 'Forward it to IT without clicking the link'],
            ['c', 'Reply to ask the sender if it is real'],
          ],
          'b',
          'Forward suspicious emails to IT without clicking their links.',
        ),
        q(
          'q5',
          'Your company laptop is stolen from your car at 9:00. By when must you report it to IT?',
          [
            ['a', 'Within 2 hours'],
            ['b', 'By the end of the week'],
            ['c', 'Only if it has not turned up after a few days'],
          ],
          'a',
          'Report a lost or stolen laptop to IT within 2 hours.',
        ),
        q(
          'q6',
          'You cannot find your laptop and want to search the house for a day before telling anyone. What is right?',
          [
            ['a', 'Search first; report only if you do not find it'],
            ['b', 'Report it to IT within 2 hours, even if you may still find it'],
            ['c', 'Tell a colleague and let them decide'],
          ],
          'b',
          'Report a lost or stolen laptop to IT within 2 hours.',
        ),
        q(
          'q7',
          'A teammate repeatedly humiliates another colleague in front of the team. What is the company position?',
          [
            ['a', 'It is acceptable if it is meant as a joke'],
            ['b', 'It is not tolerated: bullying, discrimination and harassment are not tolerated'],
            ['c', 'It is a private matter between them'],
          ],
          'b',
          'Treat colleagues, customers and partners with respect: bullying, discrimination and harassment are not tolerated.',
        ),
        q(
          'q8',
          'Which of these are not tolerated? Select all that apply.',
          [
            ['a', 'Bullying'],
            ['b', 'Discrimination'],
            ['c', 'Harassment'],
            ['d', 'Polite disagreement in a meeting'],
          ],
          ['a', 'b', 'c'],
          'Bullying, discrimination and harassment are not tolerated. Respectful disagreement is not any of these.',
        ),
        q(
          'q9',
          'Whom must you treat with respect? Select all that apply.',
          [
            ['a', 'Colleagues'],
            ['b', 'Customers'],
            ['c', 'Partners'],
            ['d', 'Only your manager'],
          ],
          ['a', 'b', 'c'],
          'Treat colleagues, customers and partners with respect.',
        ),
      ],
    },
  },
  'policies.data-protection': {
    title: 'Privacy & data handling (PDPA)',
    sourceTitle: handbookTitle,
    objectives: [
      'Know which information is confidential and for how long.',
      'Use customer data only for your job and keep it off personal devices and accounts.',
    ],
    quiz: {
      questions: [
        q(
          'q1',
          'A colleague asks you to copy a customer list to your personal Google Drive to work on it at home. What do you do?',
          [
            ['a', 'Decline and keep the list in company systems'],
            ['b', 'Copy it, then delete it on Monday'],
            ['c', 'Email it to your personal address just this once'],
          ],
          'a',
          'Never copy customer data to a personal device or a personal account.',
        ),
        q(
          'q2',
          'Which law does the company follow when handling personal data?',
          [
            ['a', 'Malaysia’s Personal Data Protection Act 2010'],
            ['b', 'No specific law; only company rules'],
            ['c', 'Singapore’s tax law'],
          ],
          'a',
          'The company handles personal data in line with Malaysia’s Personal Data Protection Act 2010.',
        ),
        q(
          'q3',
          'Which of these are confidential? Select all that apply.',
          [
            ['a', 'Customer data'],
            ['b', 'Prices'],
            ['c', 'Source code'],
            ['d', 'Business plans'],
            ['e', 'The company’s public opening hours'],
          ],
          ['a', 'b', 'c', 'd'],
          'Customer data, prices, source code and business plans are confidential.',
        ),
        q(
          'q4',
          'You are leaving the company next month. May you keep a copy of the source code you wrote?',
          [
            ['a', 'Yes, you wrote it'],
            ['b', 'No: confidentiality applies during and after your employment'],
            ['c', 'Yes, if you tell your manager'],
          ],
          'b',
          'These things stay confidential during and after your employment.',
        ),
        q(
          'q5',
          'You are curious about a customer’s records that have nothing to do with your task. May you open them?',
          [
            ['a', 'Yes, you already have access'],
            ['b', 'No: use customer data only to do your job'],
            ['c', 'Yes, if you do not copy anything'],
          ],
          'b',
          'Use customer data only to do your job.',
        ),
        q(
          'q6',
          'You want to work from home on your personal laptop and download customer data to it. What is right?',
          [
            ['a', 'Fine if you delete it afterwards'],
            ['b', 'Not allowed: never copy customer data to a personal device'],
            ['c', 'Fine if the laptop has a password'],
          ],
          'b',
          'Never copy customer data to a personal device or a personal account.',
        ),
        q(
          'q7',
          'You want to read the price list on your phone and consider emailing it to your personal address. What is right?',
          [
            ['a', 'Fine, prices are not sensitive'],
            ['b', 'Not allowed: prices are confidential and must not go to a personal account'],
            ['c', 'Fine if you delete the email'],
          ],
          'b',
          'Prices are confidential, and confidential information must never be copied to a personal account.',
        ),
        q(
          'q8',
          'A friend asks you at dinner about the company’s business plans. What do you do?',
          [
            ['a', 'Share general ideas'],
            ['b', 'Keep them confidential: business plans are confidential'],
            ['c', 'Share them if the friend promises to keep quiet'],
          ],
          'b',
          'Business plans are confidential during and after your employment.',
        ),
      ],
    },
  },
  'policies.responsible-ai': {
    title: 'Responsible AI use',
    sourceTitle: handbookTitle,
    objectives: [
      'Know which AI tools are approved.',
      'Know what must never be pasted into an unapproved tool, and who to ask first.',
    ],
    quiz: {
      questions: [
        q(
          'q1',
          'You want help debugging confidential company code and a friend suggests a free chatbot. What do you do?',
          [
            ['a', 'Use an AI tool IT has approved, such as Alya or Gemini in your company account'],
            ['b', 'Paste the code into the free chatbot without your name'],
            ['c', 'Put the code on a public page and ask the chatbot to read it'],
          ],
          'a',
          'Use only approved AI tools, and never paste source code into a tool IT has not approved.',
        ),
        q(
          'q2',
          'Which of these are approved AI tools? Select all that apply.',
          [
            ['a', 'Alya'],
            ['b', 'Gemini in your company account'],
            ['c', 'A free chatbot you found online'],
          ],
          ['a', 'b'],
          'Approved AI tools include Alya and Gemini in your company account.',
        ),
        q(
          'q3',
          'Which must never be pasted into an AI tool that IT has not approved? Select all that apply.',
          [
            ['a', 'Customer data'],
            ['b', 'Payslips'],
            ['c', 'Source code'],
            ['d', 'A public holiday date'],
          ],
          ['a', 'b', 'c'],
          'Never paste customer data, payslips or source code into an AI tool that IT has not approved.',
        ),
        q(
          'q4',
          'You found a new AI tool that summarises documents well. You think the team needs it. What do you do first?',
          [
            ['a', 'Start using it with real documents'],
            ['b', 'Ask IT first'],
            ['c', 'Use it on your personal phone'],
          ],
          'b',
          'If you think you need a different tool, ask IT first.',
        ),
        q(
          'q5',
          'You are asked to summarise a customer email thread and a tool IT has not approved would be quicker. What is right?',
          [
            ['a', 'Paste it in; it is only one thread'],
            ['b', 'Do not paste customer data into an unapproved tool'],
            ['c', 'Paste it in after removing the greeting'],
          ],
          'b',
          'Never paste customer data into an AI tool that IT has not approved.',
        ),
        q(
          'q6',
          'You need a table of payslip figures reformatted and an unapproved tool offers to do it. What is right?',
          [
            ['a', 'Fine, it is only formatting'],
            ['b', 'Not allowed: never paste payslips into an unapproved AI tool'],
            ['c', 'Fine if you hide the names'],
          ],
          'b',
          'Never paste payslips into an AI tool that IT has not approved.',
        ),
        q(
          'q7',
          'You want an AI tool to write a generic meeting agenda with no company data. Which choice is right?',
          [
            ['a', 'Use an approved tool such as Alya or Gemini in your company account'],
            ['b', 'Any public chatbot is fine if no data is involved'],
            ['c', 'Ask your friend to run it on their account'],
          ],
          'a',
          'Use only approved AI tools, such as Alya and Gemini in your company account.',
        ),
        q(
          'q8',
          'Your friend says Gemini is approved, so you may use it with your personal account. What is right?',
          [
            ['a', 'Any Gemini account is approved'],
            ['b', 'The approved tool is Gemini in your company account; use that'],
            ['c', 'Use personal accounts for sensitive work'],
          ],
          'b',
          'The approved tools are Alya and Gemini in your company account.',
        ),
      ],
    },
  },
});

// Area 2: Company Purpose & Alignment. Built only from the plan's summaries.
export const ALIGNMENT_ACTIVITIES = Object.freeze({
  // From the Company Overview (Drive document 04), section 3: business areas.
  products: {
    title: 'What the company does',
    instructions: 'Show what you know about our business areas, using the Company Overview.',
    objectives: ['Know the company’s main business areas.'],
    questions: [
      match(
        'q1',
        'Match each example to the right business area.',
        [
          ['p1', 'Web-based systems, business applications and workflow tools', 'systems'],
          ['p2', 'Virtual reality, augmented reality and 3D interactive environments', 'immersive'],
          ['p3', 'Game mechanics, rewards and challenges', 'interactive'],
          ['p4', 'Animation, 3D content and digital storytelling', 'multimedia'],
        ],
        [
          ['systems', 'Digital product & system development'],
          ['immersive', 'Immersive technology (VR/AR/XR)'],
          ['interactive', 'Interactive experiences & gamification'],
          ['multimedia', 'Creative multimedia & digital content'],
        ],
        'These are the company’s business areas, as described in the Company Overview.',
      ),
      q(
        'q2',
        'Which best describes the company?',
        [
          ['a', 'A technology and digital-solutions company'],
          ['b', 'A property developer'],
          ['c', 'An accounting firm'],
        ],
        'a',
        'The company combines technical development with creative thinking to deliver digital products and services.',
      ),
      q(
        'q3',
        'A client needs a solution for a specific business problem. What do we do first?',
        [
          ['a', 'Start building straight away'],
          ['b', 'Understand the problem, audience, expected outcome, requirements and constraints'],
          ['c', 'Wait for the client to decide everything'],
        ],
        'b',
        'We start by understanding the need, and ask questions when the brief is unclear instead of making assumptions.',
      ),
    ],
  },
  values: {
    title: 'Vision & Core Values',
    instructions:
      'Show what you know about the vision, mission and core values, using the Company Overview.',
    objectives: ['Know the vision, the mission and the seven core values.'],
    questions: [
      q(
        'q1',
        'What is the company’s vision?',
        [
          [
            'a',
            'To positively impact 1 billion people’s lives through technology, creativity and innovation',
          ],
          ['b', 'To become the largest metaverse platform in Southeast Asia'],
          ['c', 'To focus only on increasing profit'],
        ],
        'a',
        'The vision is to positively impact 1 billion people’s lives through technology, creativity and innovation.',
      ),
      q(
        'q2',
        'Which statement best describes the company’s mission?',
        [
          ['a', 'Provide social media services only'],
          [
            'b',
            'Enhance people’s lives through Information Technology, build a globally recognised image and brand, and bring together cross-discipline experts and partners',
          ],
          ['c', 'Develop technology without considering user needs'],
        ],
        'b',
        'The mission has three parts: enhance people’s lives through IT, build a globally recognised image and brand, and bring together cross-discipline industry experts and partners.',
      ),
      q(
        'q3',
        'Which are the company’s seven core values? Select all seven.',
        [
          ['a', 'Value driven'],
          ['b', 'Be happy'],
          ['c', 'Be trustworthy'],
          ['d', 'Elegant solution'],
          ['e', 'Evolve in learning'],
          ['f', 'Spread positivity'],
          ['g', 'Teamwork'],
          ['h', 'Profit first'],
        ],
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        'The seven core values are value driven, be happy, be trustworthy, elegant solution, evolve in learning, spread positivity and teamwork. “Profit first” is not one of them.',
      ),
      q(
        'q4',
        'What does “Be trustworthy” mean?',
        [
          ['a', 'Always meet deadlines regardless of quality'],
          ['b', 'Be honest, dependable and careful with company and client information'],
          ['c', 'Always say yes to every task'],
        ],
        'b',
        'Be trustworthy: be honest, dependable and careful with company and client information.',
      ),
      q(
        'q5',
        'What does “Evolve in learning” mean?',
        [
          ['a', 'Stop learning once you master your job'],
          ['b', 'Attend training only when told to'],
          ['c', 'Keep improving your knowledge, skills and professional capability'],
        ],
        'c',
        'Evolve in learning: keep developing knowledge, skills and professional capability.',
      ),
    ],
  },
  // Onboarding Quiz Part 1 (Drive document 05): company background, vision, key
  // services and core values. The tagline question is left out: no source document states it.
  teams: {
    title: 'Onboarding Quiz Part 1',
    instructions:
      'Company background, vision, key services and core values. Choose the one best answer for each question.',
    objectives: ['Know the company background, vision, mission, services and core values.'],
    questions: [
      q(
        'q1',
        'What is the full name of our company?',
        [
          ['a', 'Lumora Digital'],
          ['b', 'Lumora Digital Solutions Sdn Bhd'],
          ['c', 'Lumora Technology Group'],
          ['d', 'Lumora Interactive Malaysia'],
        ],
        'a',
        'The company is Lumora Digital.',
      ),
      q(
        'q2',
        'When was Lumora Digital established?',
        [
          ['a', '15 August 2020'],
          ['b', '23 November 2015'],
          ['c', '1 January 2021'],
          ['d', '30 June 2018'],
        ],
        'b',
        'Lumora Digital was established on 23 November 2015.',
      ),
      q(
        'q3',
        'What is Lumora Digital’s business nature?',
        [
          ['a', 'Real estate and property development'],
          [
            'b',
            'Digital solutions, mobile applications, interactive experiences, immersive technology and gamification',
          ],
          ['c', 'Accounting and financial services only'],
          ['d', 'Game publishing and social media marketing only'],
        ],
        'b',
        'The company is a technology and digital-solutions company: digital products and systems, mobile applications, interactive experiences and gamification, and immersive technology.',
      ),
      q(
        'q4',
        'Which of the following best describes Lumora Digital’s work?',
        [
          ['a', 'A 3D gaming app for entertainment only'],
          [
            'b',
            'A technology and digital-solutions company that develops digital products and interactive experiences for business and user needs',
          ],
          ['c', 'A cloud storage system only'],
          ['d', 'A social media app for professionals'],
        ],
        'b',
        'We combine technical development with creative thinking to design and deliver digital products and services.',
      ),
      q(
        'q5',
        'What is the company’s vision?',
        [
          ['a', 'To become the largest metaverse platform in Southeast Asia'],
          [
            'b',
            'To positively impact 1 billion people’s lives through technology, creativity and innovation',
          ],
          ['c', 'To create a fun virtual experience for everyone'],
          ['d', 'To empower students through immersive learning only'],
        ],
        'b',
        'The vision is to positively impact 1 billion people’s lives through technology, creativity and innovation.',
      ),
      q(
        'q6',
        'Which statement best describes the company’s mission?',
        [
          ['a', 'Focus only on increasing profit'],
          [
            'b',
            'Enhance people’s lives through IT, build a recognised brand, and bring together experts and partners',
          ],
          ['c', 'Provide social media services only'],
          ['d', 'Develop technology without considering user needs'],
        ],
        'b',
        'The mission: enhance people’s lives through IT, build a globally recognised image and brand, and bring together cross-discipline industry experts and partners.',
      ),
      q(
        'q8',
        'Which of the following is NOT one of Lumora Digital’s core values?',
        [
          ['a', 'Be happy'],
          ['b', 'Teamwork'],
          ['c', 'Profit first'],
          ['d', 'Be trustworthy'],
        ],
        'c',
        '“Profit first” is not a core value. The seven are value driven, be happy, be trustworthy, elegant solution, evolve in learning, spread positivity and teamwork.',
      ),
      q(
        'q9',
        'What does “Be trustworthy” mean at Lumora Digital?',
        [
          ['a', 'Always meet deadlines regardless of quality'],
          ['b', 'Be someone the company can trust in both words and actions'],
          ['c', 'Always say yes to every task'],
          ['d', 'Be friendly with all team members'],
        ],
        'b',
        'Be honest, dependable and careful with company and client information: someone the company can trust in words and actions.',
      ),
      q(
        'q10',
        'Which statement best describes “Evolve in learning”?',
        [
          ['a', 'Stop learning once you master your job'],
          ['b', 'Focus only on your department’s skills'],
          [
            'c',
            'Keep learning continuously to improve and stay updated with relevant knowledge and trends',
          ],
          ['d', 'Attend training only when told to'],
        ],
        'c',
        'Evolve in learning: keep improving knowledge, skills and professional capability.',
      ),
      q(
        'q11',
        'Complete the phrase: “If you want to go fast, go alone. If you want to go far, ______.”',
        [
          ['a', 'Go together'],
          ['b', 'Work harder'],
          ['c', 'Think smarter'],
          ['d', 'Lead the team'],
        ],
        'a',
        'Teamwork: share information, support colleagues and go together.',
      ),
    ],
  },
  // Onboarding Quiz Part 2 (Drive document 06): company culture, core values, do’s and
  // don’ts. Its four “in your own words” questions are not here: this quiz only grades
  // multiple-choice answers.
  roleContribution: {
    title: 'Onboarding Quiz Part 2',
    instructions:
      'Company culture, core values, do’s and don’ts. Choose the one best answer for each question.',
    objectives: ['Apply the company’s values to everyday workplace situations.'],
    questions: [
      q(
        'q1',
        'Which of the following is an appropriate way to raise a work-related issue, complaint or suggestion?',
        [
          [
            'a',
            'Contact the appropriate manager through an approved work channel or raise the matter in an appropriate internal meeting',
          ],
          ['b', 'Share confidential company matters with unrelated people online or offline'],
          ['c', 'Spread the issue among colleagues without trying to resolve it'],
          ['d', 'Post the complaint publicly before informing the company'],
        ],
        'a',
        'Raise concerns with the appropriate manager through an approved channel. Do not share confidential matters or post publicly first.',
      ),
      q(
        'q2',
        'Which statement best reflects the company’s value of Teamwork?',
        [
          ['a', 'If you want to go far, walk alone; if you want to go fast, go together'],
          ['b', 'Avoid discussing concerns so that disagreements never happen'],
          [
            'c',
            'Work collaboratively and recognise that people can achieve more together than alone',
          ],
          ['d', 'Discuss every minor matter constantly, even when it does not help the work'],
        ],
        'c',
        'Teamwork: share information, support colleagues and contribute to common goals.',
      ),
      q(
        'q3',
        'Which behaviour is NOT acceptable in the workplace?',
        [
          ['a', 'Taking approved leave for a personal matter'],
          [
            'b',
            'Deliberately excluding or isolating a colleague, gossiping or spreading harmful negativity',
          ],
          ['c', 'Raising a concern respectfully with the appropriate person'],
          ['d', 'Asking for help when a task is unclear'],
        ],
        'b',
        'Bullying, harassment and deliberately undermining another person are not acceptable. Spread positivity instead.',
      ),
      q(
        'q6',
        'Which statement best reflects the company’s value of Professionalism?',
        [
          ['a', 'Professionalism is not important for a digital-solutions company'],
          [
            'b',
            'We should respect the trust clients place in us and act, communicate and present ourselves professionally',
          ],
          ['c', 'Comfort is the only consideration when meeting a client'],
          [
            'd',
            'Clear communication and preparation are unnecessary if the audience understands the general idea',
          ],
        ],
        'b',
        'Respect the trust clients place in us: act, communicate and present yourself professionally.',
      ),
      q(
        'q8',
        'All the statements below reflect positive workplace values, EXCEPT:',
        [
          ['a', 'Create a positive and reliable experience for customers'],
          [
            'b',
            'Recognise that clients expect professionalism when they entrust us with their investment',
          ],
          ['c', 'Look for win-win outcomes when working with others'],
          ['d', 'Always put yourself first and refuse to help others'],
        ],
        'd',
        'Putting yourself first and refusing to help others goes against teamwork and spreading positivity.',
      ),
      q(
        'q9',
        'Which statement is FALSE about being value driven?',
        [
          ['a', 'Try to deliver value from the first interaction with a client'],
          ['b', 'Use knowledge, communication and experience to be helpful and resourceful'],
          ['c', 'Agree to every client request, even if it is outside scope or not authorised'],
          ['d', 'Look for ways to make a positive contribution, even through small daily actions'],
        ],
        'c',
        'Do not promise anything you are not authorised to promise. Value driven means positive impact that supports company goals.',
      ),
    ],
  },
});

// Area 3: the responsibilities checklist is built from actions, not invented
// duties: detailed role responsibilities are a content requirement.
export const RESPONSIBILITY_ITEMS = Object.freeze([
  'I know my job title and department shown above.',
  'I have asked my manager what my main responsibilities are.',
  'I have agreed my first priorities with my manager.',
]);

// Area 4: situations whose answer is stated in the onboarding plan.
export const SUPPORT_ROUTING_SCENARIOS = Object.freeze([
  {
    id: 'sit-1',
    situation: 'You receive an email asking you for your password.',
    options: [
      { id: 'it', label: 'IT: forward it to it-help@company.example without clicking links' },
      { id: 'reply', label: 'Reply to the sender' },
      { id: 'click', label: 'Click the link to check it' },
    ],
    correctId: 'it',
    explanation:
      'Forward suspicious emails to IT at it-help@company.example without clicking links.',
  },
  {
    id: 'sit-2',
    situation: 'Your company laptop has been stolen.',
    options: [
      { id: 'wait', label: 'Wait a few days to see if it turns up' },
      { id: 'it', label: 'Report it to IT within 2 hours' },
      { id: 'later', label: 'Tell a colleague at the end of the week' },
    ],
    correctId: 'it',
    explanation: 'Report a lost or stolen laptop to IT within 2 hours.',
  },
  {
    id: 'sit-3',
    situation: 'You are not sure whether an outfit meets the dress code.',
    options: [
      { id: 'it', label: 'IT' },
      { id: 'manager-pc', label: 'Your manager or People and Culture' },
      { id: 'guess', label: 'Decide for yourself and see' },
    ],
    correctId: 'manager-pc',
    explanation: 'If you are unsure about an outfit, ask your manager or People and Culture first.',
  },
  {
    id: 'sit-4',
    situation: 'You have not received the invite link to your department’s chat group.',
    options: [
      { id: 'coordinator', label: 'Your onboarding coordinator' },
      { id: 'it', label: 'it-help@company.example' },
      { id: 'wait', label: 'Nobody; groups cannot be joined later' },
    ],
    correctId: 'coordinator',
    explanation: 'Ask your onboarding coordinator if you have not received the invite link yet.',
  },
  {
    id: 'sit-5',
    situation: 'You think your team needs an AI tool that is not on the approved list.',
    options: [
      { id: 'it', label: 'Ask IT first' },
      { id: 'manager', label: 'Start using it and tell IT later' },
      { id: 'pc', label: 'Ask People and Culture' },
    ],
    correctId: 'it',
    explanation: 'If you think you need a different AI tool, ask IT first.',
  },
  {
    id: 'sit-6',
    situation: 'You cannot find the invitation to open your Individual GSheet.',
    options: [
      { id: 'coordinator', label: 'Your onboarding coordinator, who sends that invitation' },
      { id: 'it', label: 'Nobody; create your own sheet' },
      { id: 'pc', label: 'A customer' },
    ],
    correctId: 'coordinator',
    explanation: 'The invitation to your Individual GSheet comes from the onboarding coordinator.',
  },
  {
    id: 'sit-7',
    situation: 'It is your first day and you wonder who checks your original documents.',
    options: [
      { id: 'pc', label: 'People and Culture' },
      { id: 'it', label: 'IT' },
      { id: 'manager', label: 'Nobody checks them' },
    ],
    correctId: 'pc',
    explanation: 'On your first day, People and Culture checks your original documents.',
  },
  {
    id: 'sit-8',
    situation: 'You have not been added to the company-wide chat groups.',
    options: [
      { id: 'coordinator', label: 'Your onboarding coordinator, who shares those groups' },
      { id: 'it', label: 'it-help@company.example' },
      { id: 'wait', label: 'Nobody; groups are optional and cannot be joined later' },
    ],
    correctId: 'coordinator',
    explanation: 'The company-wide chat groups are shared by your onboarding coordinator.',
  },
]);

// Support contacts that appear in the onboarding plan. Manager and first-day
// contact come from the employee profile and HR's first-day details.
export const VERIFIED_SUPPORT_DIRECTORY = Object.freeze({
  contacts: [
    {
      name: 'IT',
      email: 'it-help@company.example',
      purpose: 'Suspicious emails, lost or stolen devices, and asking before using a new AI tool',
    },
    {
      name: 'People and Culture',
      email: null,
      purpose: 'Questions about the dress code and other company rules; verifies your documents',
    },
    {
      name: 'Onboarding coordinator',
      email: null,
      purpose: 'Chat-group invitations, tool invitations and onboarding questions',
    },
  ],
});

// Routing scenarios as single-choice questions, so one engine runs every activity.
export const routingQuestions = (scenarios) =>
  scenarios.map((s) => ({
    id: s.id,
    type: 'single',
    multiple: false,
    prompt: s.situation,
    options: s.options.map((o) => ({ id: o.id, text: o.label })),
    correct: [s.correctId],
    explanation: s.explanation,
  }));

// Whether one question is answered correctly: single/multi need the selected
// options to equal the answer key; match needs every pair to carry its key.
export function isCorrectAnswer(question, value) {
  if (question.type === 'match') {
    const given = value && typeof value === 'object' ? value : {};
    return question.pairs.every((pair) => given[pair.id] === pair.correct);
  }
  const given = [].concat(value ?? []).map(String);
  return (
    given.length === question.correct.length && question.correct.every((id) => given.includes(id))
  );
}

// Whether a submitted answer has the right shape for its question: known option
// ids only, exactly one for a single-choice question, a choice for every pair of
// a match question. Throws nothing; the caller answers 400.
export function validAnswer(question, value) {
  if (question.type === 'match') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const choices = question.choices.map((choice) => choice.id);
    return question.pairs.every((pair) => choices.includes(value[pair.id]));
  }
  const given = [].concat(value ?? []);
  const ids = question.options.map((option) => option.id);
  if (!given.length || !given.every((id) => typeof id === 'string' && ids.includes(id)))
    return false;
  if (new Set(given).size !== given.length) return false;
  return question.multiple ? true : given.length === 1;
}

// The feedback shown right after an answer is locked, from the server's own key.
// Only called for an answer already recorded, so showing the key leaks nothing.
export function answerFeedback(question, value) {
  const correct = isCorrectAnswer(question, value);
  const base = { questionId: question.id, correct, explanation: question.explanation };
  if (question.type === 'match') {
    const given = value && typeof value === 'object' ? value : {};
    return {
      ...base,
      correctPairs: Object.fromEntries(question.pairs.map((pair) => [pair.id, pair.correct])),
      wrongPairs: question.pairs.filter((pair) => given[pair.id] !== pair.correct).map((p) => p.id),
    };
  }
  const given = [].concat(value ?? []).map(String);
  return {
    ...base,
    correctAnswer: question.correct,
    // For a multiple-choice question: what was left out and what should not have been picked.
    missed: question.correct.filter((id) => !given.includes(id)),
    extra: given.filter((id) => !question.correct.includes(id)),
  };
}

// Grades answers. Anything unanswered is wrong.
export function gradeQuestions(questions, answers = {}) {
  const results = questions.map((question) => {
    const correct = isCorrectAnswer(question, answers[question.id]);
    return { id: question.id, correct, ...(correct ? {} : { explanation: question.explanation }) };
  });
  const right = results.filter((result) => result.correct).length;
  return { results, score: Math.round((right / questions.length) * 100) };
}

export const stripAnswers = (questions) =>
  questions.map((question) =>
    question.type === 'match'
      ? {
          id: question.id,
          type: 'match',
          prompt: question.prompt,
          pairs: question.pairs.map(({ id, text }) => ({ id, text })),
          choices: question.choices,
        }
      : {
          id: question.id,
          type: question.multiple ? 'multi' : 'single',
          prompt: question.prompt,
          multiple: Boolean(question.multiple),
          options: question.options,
        },
  );

// What the browser may see: never the answer keys or explanations. `content`
// is the merged content from verification-content.mjs.
export function publicVerificationContent(content, env = process.env) {
  const policyScore = policyPassingScore(env);
  const alignmentScore = alignmentPassingScore(env);
  const policies = Object.fromEntries(
    Object.entries(content.policies).map(([id, policy]) => [
      id,
      {
        title: policy.title,
        sourceTitle: policy.sourceTitle,
        objectives: policy.objectives || [],
        ...(policy.document ? { document: policy.document } : {}),
        // A policy without approved quiz material is acknowledgement-only.
        quiz: policy.quiz
          ? { passingScore: policyScore, questions: stripAnswers(policy.quiz.questions) }
          : null,
      },
    ]),
  );
  const check = (activity) => ({
    title: activity.title,
    instructions: activity.instructions,
    objectives: activity.objectives || [],
    passingScore: alignmentScore,
    questions: stripAnswers(activity.questions),
    ...(activity.notesPrompt ? { notesPrompt: activity.notesPrompt } : {}),
  });
  return {
    policies,
    alignment: {
      products: check(ALIGNMENT_ACTIVITIES.products),
      values: check(ALIGNMENT_ACTIVITIES.values),
      teams: check(ALIGNMENT_ACTIVITIES.teams),
      roleContribution: check(ALIGNMENT_ACTIVITIES.roleContribution),
    },
    responsibilities: content.responsibilities,
    supportRouting: {
      title: 'Find the right contact',
      instructions: 'Choose the right contact or channel for each situation.',
      objectives: [
        'Know who to go to for IT, People and Culture, your manager and your coordinator.',
      ],
      passingScore: alignmentScore,
      questions: stripAnswers(routingQuestions(content.supportRouting)),
    },
    verifiedDirectory: content.directory,
    config: {
      policyPassingScore: policyScore,
      alignmentPassingScore: alignmentScore,
      allowRetries: true,
    },
  };
}

const storageError = () =>
  new ChatError(
    503,
    'VERIFICATION_STORAGE_UNAVAILABLE',
    'Your progress could not be saved or loaded because the storage service is unavailable. Please try again shortly.',
  );

// Verification records live in Firestore (taskVerifications/{accountId}). Without
// a configured Firestore (tests only) they stay in this process's memory; a
// Firestore that is configured but failing raises an error rather than falling
// back to memory, so nothing is ever reported as saved when it was not.
export function createTaskVerificationStore({
  firestore,
  now = () => new Date(),
  log = console.warn,
} = {}) {
  const memory = new Map();
  const config = () => ({ passingScore: policyPassingScore(), allowRetries: true });
  const getDb = async () => (typeof firestore === 'function' ? await firestore() : firestore);
  const ref = (db, id) => db.collection(journeyCollections.taskVerifications).doc(id);

  async function getVerifications(accountId) {
    if (!accountId) return { verifications: {}, config: config() };
    let db;
    try {
      db = await getDb();
      if (db) {
        const doc = await ref(db, accountId).get();
        return {
          verifications: (doc?.exists && doc.data().verifications) || {},
          config: config(),
        };
      }
    } catch (e) {
      log('task-verification: read error: ' + (e?.message || e));
      throw storageError();
    }
    return {
      verifications: structuredClone(memory.get(accountId)?.verifications || {}),
      config: config(),
    };
  }

  // Read-modify-write in one transaction, so two quick submissions never lose each other.
  async function saveVerification(accountId, updater) {
    let db;
    try {
      db = await getDb();
      if (db) {
        return await db.runTransaction(async (tx) => {
          const doc = await tx.get(ref(db, accountId));
          const current = (doc?.exists && doc.data().verifications) || {};
          const record = {
            accountId,
            updatedAt: now().toISOString(),
            verifications: updater(current),
          };
          tx.set(ref(db, accountId), record);
          return { ...record, config: config() };
        });
      }
    } catch (e) {
      if (e instanceof ChatError) throw e;
      log('task-verification: write error: ' + (e?.message || e));
      throw storageError();
    }
    const record = {
      accountId,
      updatedAt: now().toISOString(),
      verifications: updater(structuredClone(memory.get(accountId)?.verifications || {})),
    };
    memory.set(accountId, record);
    return { ...record, config: config() };
  }

  return { getVerifications, saveVerification };
}
