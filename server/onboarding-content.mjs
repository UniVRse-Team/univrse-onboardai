// The built-in onboarding footprint (issue #47) and quick-question chips
// (issue #50). The Firestore migrations copy these into
// onboardingTemplates/{track} and config/quickQuestions; the server falls back
// to them whenever those documents are missing, malformed or older than this
// version. See docs/onboarding-journey.md.
//
// Any change to this content needs a templateVersion bump AND a Firestore
// migration that writes the new version (like 003_onboarding_templates_v2):
// the migrations are forward-only, and a migration that already ran never
// runs again, so a stack seeded with the old content keeps it otherwise.
//
// Step ids are "<areaId>.<slug>" and stable forever: onboardingProgress is keyed
// by them. A track keeps the same id for the same structural step (an intern's
// internship agreement is documentation.contract), so changing an employee's
// track keeps the progress that still applies.
//
// Every track has the same required steps per area (see the list below). Optional steps (required: false) never count.
// Every required step has Alya's briefing (contract v1.5): 2 to 4 plain
// sentences, at most 400 characters, with no links, lists or headings so it
// reads well aloud, grounded in the company documents named by sourceTitle
// (null where the documents do not cover the step, and the text then states no
// company facts). The policy checks (contract v1.4) are grounded in the
// Employee Handbook (version 3.2, effective 1 October 2026). Only short
// paraphrases are kept here, never the document text.

export const tracks = Object.freeze(['employee', 'intern', 'contractor']);
export const defaultTrack = 'employee';
export const areaOrder = Object.freeze([
  'documentation',
  'policies',
  'alignment',
  'role-tools',
  'team-support',
]);
export const completionTypes = Object.freeze(['self', 'hr_verify', 'check']);
export const checkTypes = Object.freeze(['choice', 'written']);
export const templateVersion = 9;
// Every area must reach this percent of its required steps (contract v1.2).
export const completionThreshold = 70;
export const briefingMaxLength = 400;
export const writtenAnswerMaxLength = 600;
// The company's approved documents, in its shared Drive folder.
export const driveLinks = Object.freeze({
  form: 'https://drive.google.com/file/d/1OHEjggUwDEWldz0371Idks70A2zy_o_A/view?usp=drivesdk',
  handbook: 'https://drive.google.com/file/d/1LQYEoE7u4Rq-dUXplAzVzhRfwwgwM_zV/view?usp=drivesdk',
  conduct: 'https://drive.google.com/file/d/1T-Gx7KzH5JF05hMkP8BT_ob2_bWE1qK2/view?usp=drivesdk',
  overview: 'https://drive.google.com/file/d/1YHvTgCL_c6bLmzYU-Zko-lSAhVACyIp-/view?usp=drivesdk',
  roleTools: 'https://drive.google.com/file/d/18-eP4w1DgzyOHK18xD8Lm0rosKMiVj8D/view?usp=drivesdk',
  peopleSupport:
    'https://drive.google.com/file/d/1MYmtFB6ok4CCXGPbFCIDVVio12K_EWiR/view?usp=drivesdk',
});
export const handbookTitle = 'Employee Handbook';
export const checklistTitle = 'New Staff Checklist';
export const orientationTitle = 'Orientation & Office Tour Guide';
export const contractTitle = 'Signing Your Employment Contract';
export const roleToolsTitle = '07 Role, Tools & AI Readiness';
export const peopleSupportTitle = '08 People & Workplace Support';

// A profile's job.track as a track: '' (or anything unknown) means employee.
export const trackOf = (profile) =>
  tracks.includes(profile?.job?.track) ? profile.job.track : defaultTrack;

const briefing = (sourceTitle, text) => ({ text, sourceTitle });
const self = (slug, title, description, askAlya, brief) => ({
  slug,
  title,
  description,
  required: true,
  completion: 'self',
  askAlya,
  briefing: brief,
});
const hrVerify = (slug, title, description, askAlya, brief) => ({
  slug,
  title,
  description,
  required: true,
  completion: 'hr_verify',
  askAlya,
  briefing: brief,
});
const checked = (slug, title, description, askAlya, brief, check) => ({
  slug,
  title,
  description,
  required: true,
  completion: 'check',
  askAlya,
  briefing: brief,
  check: { ...check, sourceTitle: check.sourceTitle || handbookTitle },
});

// The four Policies & Safe Practices checks, one per policy step, grounded in
// the Employee Handbook (contract v1.4), plus the two Role, Tools & AI Readiness
// checks grounded in 07 Role, Tools & AI Readiness:
// - choice checks: option ids are opaque and stable, so an id says nothing
//   about its position, and GET .../check shuffles the options on every request;
// - written checks: the employee writes an answer that Alya grades against
//   keyPoints and mustNot; the server decides the pass (check-grader.mjs). The
//   modelAnswer and the rubric are never sent to the browser.
const checks = {
  handbook: {
    type: 'choice',
    scenario:
      'It is a Wednesday and you have no client meetings. Which outfit fits the weekday dress code?',
    options: [
      { id: 'q4m7', text: 'Ripped jeans, a T-shirt and slippers' },
      { id: 'z2k9', text: 'Short pants, a polo shirt and sandals' },
      { id: 'h8t3', text: 'A neat shirt and clean trousers' },
    ],
    correctOptionId: 'h8t3',
    explanation:
      'The Employee Handbook describes smart-casual attire for the office and restricts ripped jeans, short pants, T-shirts and slippers on weekdays. Business attire may be required for client meetings.',
  },
  conduct: {
    type: 'choice',
    scenario:
      'An email that says it is from IT asks you to reply with your password so your account can be “verified”. What should you do?',
    options: [
      { id: 'w5n1', text: 'Forward it to it-help@company.example, then delete it' },
      { id: 'c3x8', text: 'Reply with your password so that IT can verify you' },
      { id: 'p9v2', text: 'Open the link in it to check that the request is real' },
    ],
    correctOptionId: 'w5n1',
    explanation:
      'Never share your password, including with IT: IT will never ask for it. Forward suspicious emails to it-help@company.example and do not click their links or open their attachments.',
  },
  data: {
    type: 'written',
    scenario:
      'A colleague asks you to copy a customer list to your personal Google Drive, so the two of you can work on it at home over the weekend. What do you do, and why? Answer in two or three sentences.',
    keyPoints: [
      {
        id: 'kp-no-personal-copy',
        text: 'Says they will not copy the customer list to a personal device or a personal account (they decline, or keep the list in company systems instead).',
      },
      {
        id: 'kp-confidential',
        text: 'Gives the reason: customer data is confidential and may be used only to do their job.',
      },
    ],
    mustNot: [
      {
        id: 'mn-copies-personal',
        text: 'Agrees to copy, email, upload or move the customer list to a personal device, personal email or personal cloud storage, even for a short time.',
      },
      {
        id: 'mn-shares-outside',
        text: 'Suggests sharing the customer list with people or tools that have no work need for it.',
      },
    ],
    modelAnswer:
      'I would decline and keep the customer list in our company systems, working on it there with my company account. Customer data is confidential and may be used only to do our jobs, so it must never be copied to personal devices or accounts.',
    explanation:
      'Customer data is confidential. It may be used only to do your job and must never be copied to personal devices or accounts, during or after your employment.',
    maxLength: writtenAnswerMaxLength,
  },
  ai: {
    type: 'written',
    scenario:
      'You are stuck on a bug and would like an AI tool to explain some company source code. A friend recommends a free AI chatbot. What do you do? Answer in two or three sentences.',
    keyPoints: [
      {
        id: 'kp-approved-tool',
        text: 'Uses only an approved AI tool, such as Alya or Gemini in their company account, or asks IT before using any other tool.',
      },
      {
        id: 'kp-no-unapproved-paste',
        text: 'Says they will not paste the source code into the free chatbot or any other AI tool that IT has not approved.',
      },
    ],
    mustNot: [
      {
        id: 'mn-pastes-unapproved',
        text: 'Pastes or uploads the source code into the free chatbot or another AI tool that IT has not approved.',
      },
      {
        id: 'mn-copies-code-out',
        text: 'Copies the source code to a personal device or personal account so they can use another AI tool.',
      },
    ],
    modelAnswer:
      'I would not paste the code into the free chatbot, because source code must never go into an AI tool that IT has not approved. Instead I would ask Alya or Gemini in my company account, or check with IT first if I need a different tool.',
    explanation:
      'Use only approved AI tools, such as Alya and Gemini in your company account. Never paste customer data, payslips or source code into an AI tool that IT has not approved.',
    maxLength: writtenAnswerMaxLength,
  },
  gsheetSop: {
    type: 'choice',
    sourceTitle: roleToolsTitle,
    scenario:
      'You are starting your basic GSheet training, but you are unsure how to update a task status and cannot open one of your assigned sheets. What should you do?',
    options: [
      {
        id: 'm4p8',
        text: 'Follow the GSheet SOP instructions and report the access issue to the onboarding coordinator',
      },
      {
        id: 'v7r2',
        text: 'Create a personal spreadsheet on your private account and track your daily tasks there instead',
      },
      {
        id: 'k3n6',
        text: 'Ask a colleague to share their password so you can update your status from their account',
      },
    ],
    correctOptionId: 'm4p8',
    explanation:
      'Study the GSheet SOP to learn where to find tasks and how to update their status. Keep your account passwords private and report any access or setup problems to the onboarding coordinator.',
  },
  gsheetDailyUpdates: {
    type: 'written',
    sourceTitle: roleToolsTitle,
    scenario:
      'At the end of the day, you have finished one task in your Individual GSheet, made partial progress on a second task, and hit a blocker on a third. How should you update your GSheet? Answer in two or three sentences.',
    keyPoints: [
      {
        id: 'kp-honest-progress',
        text: 'Says they will update their tasks honestly and clearly with their current progress and completed work.',
      },
      {
        id: 'kp-report-issue',
        text: 'Says they will record or note the blocker or issue that needs help.',
      },
    ],
    mustNot: [
      {
        id: 'mn-hide-issue',
        text: 'Suggests hiding the blocker, marking incomplete work as finished, or skipping the daily update.',
      },
      {
        id: 'mn-unapproved-ai',
        text: 'Suggests pasting confidential company or personal data into an unapproved AI tool.',
      },
    ],
    modelAnswer:
      'I would update my Individual GSheet honestly and clearly by recording the completed task and the current progress on the second task. I would also note the blocker on the third task as an issue that needs help so the team can support me.',
    explanation:
      'Update your tasks in GSheet honestly and clearly each day, including your progress, completed work, and any issue that needs help.',
    maxLength: writtenAnswerMaxLength,
  },
};

// The user's area titles, descriptions and icons (contract v1.2, verbatim).
const areaText = {
  documentation: {
    icon: '📄',
    title: 'Documentation',
    description: 'Complete required forms and submit documents.',
  },
  policies: {
    icon: '🛡️',
    title: 'Policies & Safe Practices',
    description: 'Understand company rules, privacy and responsible AI use.',
  },
  alignment: {
    icon: '🎯',
    title: 'Company Purpose & Alignment',
    description: 'Understand what the company does, its goals and how your role contributes.',
  },
  'role-tools': {
    icon: '🛠️',
    title: 'Role, Tools & AI Readiness',
    description:
      'Set up work tools, understand your responsibilities and identify suitable AI training.',
  },
  'team-support': {
    icon: '🤝',
    title: 'People & Workplace Support',
    description:
      'Know your teammates, who to ask for help and optionally share working preferences or support needs.',
  },
};

// Every track shares the same steps: Documentation 1, Policies 2, Alignment 3,
// Role & Tools 1 (optional), People & Support 1 (optional). The 70% rule applies to
// each area's required steps; the Role responsibilities checklist is an area activity.
const policies = [
  checked(
    'employee-handbook',
    'Company rules (Employee Handbook)',
    'Read the Employee Handbook, especially working hours, the dress code, claims and leave, then answer a short scenario.',
    'What does the Employee Handbook say about the dress code?',
    briefing(
      handbookTitle,
      'Normal working hours from Monday to Thursday are 9:00 to 12:30 and 1:30 to 5:30, and there is a regular internal meeting on Friday morning at 9:30. Dress smart casual: ripped jeans, short pants, T-shirts and slippers are restricted on weekdays. If you are unsure about anything, ask your manager or HR.',
    ),
    checks.handbook,
  ),
  self(
    'company-sop-policies',
    'Read the Business Conduct Policy',
    'Read the company’s Business Conduct Policy (meetings, email and messaging, confidentiality, fair competition and anti-bribery), then confirm that you have read it.',
    'What does the Business Conduct Policy cover?',
    briefing(
      null,
      'Read the Business Conduct Policy, which sets out the standards for meetings, email and messaging, confidentiality, fair competition and anti-bribery. Open it with the link on this task, then confirm here once you have read it. Ask HR if anything is unclear.',
    ),
  ),
];
// Approved policy checks that are not part of the current checklist (kept so HR can
// add them to a stored template, and so the check machinery stays covered).
const additionalPolicies = [
  checked(
    'workplace-conduct',
    'Workplace conduct & safe practices',
    'Learn how we treat each other and keep accounts and devices safe, then answer a short scenario.',
    'What should I do with a suspicious email or a lost laptop?',
    briefing(
      handbookTitle,
      'Treat colleagues, customers and partners with respect: bullying, discrimination and harassment are not tolerated. Never share your password, not even with IT, because IT will never ask for it. Forward suspicious emails to IT without clicking their links, and report a lost or stolen laptop to IT within 2 hours.',
    ),
    checks.conduct,
  ),
  checked(
    'data-protection',
    'Privacy & data handling (PDPA)',
    'Learn how personal and customer data is protected, then answer a short scenario in your own words.',
    'How should I handle customer and personal data?',
    briefing(
      handbookTitle,
      'The company handles personal data in line with Malaysia’s Personal Data Protection Act 2010. Customer data, prices, source code and business plans are confidential, during and after your employment. Use customer data only to do your job, and never copy it to a personal device or a personal account.',
    ),
    checks.data,
  ),
  checked(
    'responsible-ai',
    'Responsible AI use',
    'Learn which AI tools are approved and what must never go into them, then answer a short scenario in your own words.',
    'Which AI tools am I allowed to use at work?',
    briefing(
      handbookTitle,
      'Use only approved AI tools, such as Alya and Gemini in your company account. Never paste customer data, payslips or source code into an AI tool that IT has not approved. If you think you need a different tool, ask IT first.',
    ),
    checks.ai,
  ),
];
const additionalAlignment = [
  self(
    'products-customers',
    'What the company does',
    'Learn what we build and who our customers are.',
    'What does the company do, and who are our customers?',
    briefing(
      handbookTitle,
      'The company builds booking and scheduling software for clinics, salons and wellness studios in Malaysia and Singapore. Our two products are Book, for bookings and scheduling, and Pay, for payments. About 2,400 businesses use them today.',
    ),
  ),
];
const alignment = [
  self(
    'mission-values',
    'Read and Understand Company Overview',
    'Read the Company Overview, then show what you know about the vision, mission and core values.',
    'What are the company’s vision, mission and core values?',
    briefing(
      handbookTitle,
      'Our vision is to positively impact 1 billion people’s lives through technology, creativity and innovation. Our mission is to enhance people’s lives through IT, build a globally recognised brand and bring together experts and partners. The seven core values are value driven, be happy, be trustworthy, elegant solution, evolve in learning, spread positivity and teamwork.',
    ),
  ),
  self(
    'org-structure',
    'Complete Onboarding Quiz Part 1',
    'Answer the short onboarding quiz on the company background, vision, services and core values. Read the Company Overview first.',
    'What does the company do?',
    briefing(
      handbookTitle,
      'Lumora Digital was established on 23 November 2015 and is a technology and digital-solutions company. Its business areas include digital product and system development, mobile applications, interactive experiences and gamification, immersive technology and creative multimedia. Read the Company Overview before taking the quiz.',
    ),
  ),
  self(
    'role-contribution',
    'Complete Onboarding Quiz Part 2',
    'Answer the short onboarding quiz on company culture, core values and workplace do’s and don’ts. Read the Company Overview first.',
    'How do the core values apply at work?',
    briefing(
      handbookTitle,
      'Part 2 applies the core values to workplace situations, such as raising an issue through the right channel, working as a team and acting professionally with clients. Never promise anything you are not authorised to promise. Read the Company Overview before taking the quiz.',
    ),
  ),
];
const workingPreferences = {
  ...self(
    'working-preferences',
    'Share your working preferences or support needs (optional)',
    'If you would like to, tell your manager or People & Culture how you prefer to work, or about any support you need. This never affects your progress.',
    'How can I share my working preferences or support needs?',
    null,
  ),
  required: false,
};
const roleTools = [
  {
    ...self(
      'ai-readiness-training',
      'AI Readiness self-assessment and practice task (optional)',
      'Rate your AI experience from 1 to 10 (or skip the rating) to get a tailored learning path and a quick practice task. This never affects your progress.',
      'How does the AI proficiency self-assessment work, and what training should I complete?',
      null,
    ),
    required: false,
  },
];
const teamSupport = [workingPreferences];
// Documentation is the same for every track: three documents the employee saves.
const documentation = [
  hrVerify(
    'employee-information-form',
    'Upload your Employee Information Form',
    'Download the Employee Information Form, complete it, then upload the completed form.',
    'How do I submit my Employee Information Form?',
    briefing(
      null,
      'Upload your completed Employee Information Form. The task is complete once your document is saved. HR reviews documents separately.',
    ),
  ),
];
const stepsByTrack = Object.fromEntries(
  tracks.map((track) => [
    track,
    {
      documentation,
      policies,
      alignment,
      'role-tools': roleTools,
      'team-support': teamSupport,
    },
  ]),
);

// The same shape as a template step, for HR-stored templates and tests.
const asTemplateSteps = (areaId, list) =>
  list.map(({ slug, check, briefing: brief, ...step }) => ({
    id: `${areaId}.${slug}`,
    ...step,
    briefing: brief ? { ...brief } : null,
    ...(check ? { check: structuredClone(check) } : {}),
  }));
export const additionalPolicySteps = asTemplateSteps('policies', additionalPolicies);
export const additionalAlignmentSteps = asTemplateSteps('alignment', additionalAlignment);

// The template document for a track, as stored in onboardingTemplates/{track}.
// Related questions Alya suggests when an employee asks about a task (after the task's
// own question). They are only prompts: Alya's answers come from the company documents.
export const stepQuestions = Object.freeze({
  'documentation.tax-id-documents': [
    'Which file types can I upload?',
    'Who can see the documents I upload?',
  ],
  'documentation.personal-bank-details': [
    'What details go into the Employees/Interns Record?',
    'How do I correct my details later?',
  ],
  'documentation.employee-information-form': [
    'What do I need to fill in on the Employee Information Form?',
    'Which documents are on the form’s checklist?',
  ],
  'policies.employee-handbook': [
    'What are the working hours?',
    'What is the dress code?',
    'How do I apply for annual leave?',
  ],
  'policies.company-sop-policies': [
    'What are the rules for email and chat messages?',
    'What should I do if I receive a gift from a client?',
  ],
  'policies.sop-internal-meeting': [
    'What should I prepare before a meeting?',
    'How are meeting minutes and action items recorded?',
  ],
  'alignment.mission-values': [
    'What are the company’s seven core values?',
    'What is the difference between the vision and the mission?',
  ],
  'alignment.social-media-accounts': [
    'Which social media accounts does the company have?',
    'Can I post about the company on my own account?',
  ],
  'alignment.org-structure': ['When was the company established?', 'What does the company do?'],
  'alignment.role-contribution': [
    'What does “Be trustworthy” mean at work?',
    'How should I raise a concern at work?',
  ],
  'role-tools.gsheet-account': [
    'Which Google account should I use for GSheet?',
    'What if I cannot open the assigned sheet?',
  ],
  'role-tools.individual-gsheet': [
    'Where do I find the invitation to my Individual GSheet?',
    'What can I do in my Individual GSheet?',
  ],
  'role-tools.gsheet-training-sop': [
    'Where do I find my tasks in the GSheet?',
    'How do I update a task’s status?',
  ],
  'role-tools.drive-shared-folders': [
    'Which Drive folders do I need for my role?',
    'Who do I ask if I cannot open a shared folder?',
  ],
  'role-tools.gmail-google-chat': [
    'How do I use Google Chat for my team?',
    'Which account do I use for Gmail?',
  ],
  'role-tools.gmail-profile-picture': [
    'What kind of profile picture is suitable?',
    'How do I change my Gmail profile picture?',
  ],
  'role-tools.professional-email': [
    'Which email address should I use for work?',
    'How do I check that my work email works?',
  ],
  'role-tools.link-official-email': [
    'How do I add my work email to Gmail?',
    'How can I test that the linked email works?',
  ],
  'role-tools.email-signature': [
    'What details go in my email signature?',
    'Where do I set up the signature in Gmail?',
  ],
  'role-tools.gsheet-daily-updates': [
    'What should a daily update include?',
    'What should I do when I am blocked on a task?',
  ],
  'role-tools.ai-readiness-training': [
    'What do the AI proficiency levels from 1 to 10 mean?',
    'What happens if I skip the AI self-assessment?',
    'What is the practice task after the assessment?',
  ],
  'team-support.company-chat-groups': [
    'Which company chat groups should I join?',
    'Who shares the chat group links?',
  ],
  'team-support.department-chat-group': [
    'How do I join my department’s chat group?',
    'Who do I ask if I have not received the invite?',
  ],
  'team-support.talent-personality-test': [
    'How do I take the Talent Personality Test?',
    'Who do I share the result with?',
  ],
  'team-support.mbti-personality-test': [
    'How do I take the MBTI Personality Test?',
    'How is the MBTI result used?',
  ],
  'team-support.working-preferences': [
    'What can I share about how I prefer to work?',
    'Who can see what I share?',
  ],
});

// The company document each task points to (added to the task's description as a link).
const stepLinks = {
  'documentation.employee-information-form': driveLinks.form,
  'policies.company-sop-policies': driveLinks.conduct,
  'policies.sop-internal-meeting': driveLinks.conduct,
  'alignment.mission-values': driveLinks.overview,
  'alignment.org-structure': driveLinks.overview,
  'alignment.role-contribution': driveLinks.overview,
};
const stepLink = (id) => stepLinks[id] || null;
// People & Support has one guide, linked once on the area. Role & Tools has none.
const areaLinks = { 'team-support': driveLinks.peopleSupport };

export function builtInTemplate(track = defaultTrack) {
  const chosen = tracks.includes(track) ? track : defaultTrack;
  return {
    track: chosen,
    version: templateVersion,
    threshold: completionThreshold,
    areas: areaOrder.map((areaId) => ({
      id: areaId,
      icon: areaText[areaId].icon,
      title: areaText[areaId].title,
      description: [areaText[areaId].description, areaLinks[areaId]].filter(Boolean).join(' '),
      steps: stepsByTrack[chosen][areaId].map(({ slug, check, briefing: brief, ...step }) => ({
        id: `${areaId}.${slug}`,
        ...step,
        description: [step.description, stepLink(`${areaId}.${slug}`)].filter(Boolean).join(' '),
        briefing: brief ? { ...brief } : null,
        ...(check ? { check: structuredClone(check) } : {}),
      })),
    })),
  };
}

// config/quickQuestions: the general chips per track. Personal chips are
// answered from the employee's first-day details, never from the documents.
const generalChips = () => [
  {
    id: 'company-background',
    label: 'Explain the company background',
    question: 'Explain the company background',
    kind: 'knowledge',
  },
  {
    id: 'working-hours',
    label: 'What are the working hours?',
    question: 'What are the working hours?',
    kind: 'knowledge',
  },
  {
    id: 'dress-code',
    label: 'What’s the dress code?',
    question: 'What’s the dress code?',
    kind: 'knowledge',
  },
  {
    id: 'day-one-arrival',
    label: 'Where and what time do I report on day 1?',
    question: 'Where and what time do I report on day 1?',
    kind: 'personal',
    personal: 'arrival',
  },
  {
    id: 'day-one-host',
    label: 'Who will meet me on my first day?',
    question: 'Who will meet me on my first day?',
    kind: 'personal',
    personal: 'host',
  },
];
export function builtInQuickQuestions() {
  return Object.fromEntries(tracks.map((track) => [track, generalChips()]));
}
