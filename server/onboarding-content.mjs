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
export const templateVersion = 8;
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

// Every track shares the same steps: Documentation 3, Policies 3, Alignment 4,
// Role & Tools 10, People & Support 4 (the 70% rule applies to each area).
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
  self(
    'sop-internal-meeting',
    'Read and understand the SOP for Internal Meetings',
    'Read the meeting sections of the Business Conduct Policy (preparing for, running and following up a meeting), then confirm that you have read and understood them.',
    'How should I prepare for and follow up an internal meeting?',
    briefing(
      null,
      'The Business Conduct Policy explains how to prepare for, run and follow up meetings: agree an agenda, arrive five minutes early, and record decisions and action items with owners and due dates. Read it with the link on this task, then confirm here. The regular internal meeting is on Friday at 9:30 a.m.',
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
    'Read and understand the company’s Vision & Core Values',
    'Read the Company Overview, then show what you know about the vision, mission and core values.',
    'What are the company’s vision, mission and core values?',
    briefing(
      handbookTitle,
      'Our vision is to positively impact 1 billion people’s lives through technology, creativity and innovation. Our mission is to enhance people’s lives through IT, build a globally recognised brand and bring together experts and partners. The seven core values are value driven, be happy, be trustworthy, elegant solution, evolve in learning, spread positivity and teamwork.',
    ),
  ),
  self(
    'social-media-accounts',
    'Add the company social media accounts',
    'Follow or add the company’s official social media accounts (LinkedIn, Facebook, Instagram and YouTube) from the links shared by the company, then confirm here.',
    'Which company social media accounts should I add?',
    briefing(
      null,
      'The Company Overview lists the official channels: LinkedIn, Facebook, Instagram, YouTube and the website. The account links are still to be added by the company, so use only links shared by the company or its approved internal directory. Do not create accounts or post for the company without authorisation.',
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
  self(
    'gsheet-account',
    'Set up an account in GSheet',
    'Use the Google account provided or approved for work to access the assigned Google Sheet (GSheet).',
    'How do I set up my account in GSheet?',
    briefing(
      roleToolsTitle,
      'Use the Google account provided or approved for work to access your assigned Google Sheet. Make sure you are signed in with your work account before opening the sheet.',
    ),
  ),
  self(
    'individual-gsheet',
    'Accept the invitation to open your Individual GSheet',
    'Open the invitation from the onboarding coordinator and check that you can access your individual sheet.',
    'How do I open my Individual GSheet invitation?',
    briefing(
      roleToolsTitle,
      'Check your inbox for the invitation from the onboarding coordinator to open your Individual GSheet. Open the sheet and confirm that you can view and edit your assigned rows.',
    ),
  ),
  checked(
    'gsheet-training-sop',
    'Complete basic GSheet training and study the GSheet SOP',
    'Learn where to find tasks, how to update their status, and how to follow the instructions provided in the GSheet SOP.',
    'What should I learn in the GSheet training and GSheet SOP?',
    briefing(
      roleToolsTitle,
      'Complete the basic GSheet training and study the GSheet Standard Operating Procedure. Learn where your tasks are listed, how to update their status, and how to follow the instructions in the SOP.',
    ),
    checks.gsheetSop,
  ),
  self(
    'drive-shared-folders',
    'Share relevant documents and folders in Drive',
    'Check that you can access the Google Drive folders needed for your role and follow the access instructions given.',
    'How do I access and share relevant folders in Google Drive?',
    briefing(
      roleToolsTitle,
      'Check that you can access the Google Drive folders needed for your role. Use those shared folders for your work files and follow the access instructions given by your team.',
    ),
  ),
  self(
    'gmail-google-chat',
    'Create a Gmail account / use Google Chat',
    'Use the work account or communication method provided for onboarding. Google Chat is used to communicate with the relevant team.',
    'How do I set up Gmail and Google Chat for onboarding?',
    briefing(
      roleToolsTitle,
      'Use the work account or communication method provided for onboarding to sign in to Gmail and Google Chat. Google Chat is used to communicate with your team throughout the day.',
    ),
  ),
  self(
    'gmail-profile-picture',
    'Add a proper picture to your Gmail profile',
    'Use a clear and professional profile picture that is suitable for a workplace account.',
    'What kind of picture should I use for my Gmail profile?',
    briefing(
      roleToolsTitle,
      'Add a clear and professional profile picture to your Gmail account. Choose a photo that is suitable for a workplace account so colleagues can recognise you easily.',
    ),
  ),
  self(
    'professional-email',
    'Create a professional email for the new employee',
    'Use the company email address or account assigned to you for work-related communication.',
    'Which email account should I use for work communication?',
    briefing(
      roleToolsTitle,
      'Use the company email address or account assigned to you for all work-related communication. Check that you can send and receive messages from your assigned address.',
    ),
  ),
  self(
    'link-official-email',
    'Link the official email to Gmail',
    'If instructed, connect or add the official work email to Gmail and check that it is working.',
    'How do I link my official work email to Gmail?',
    briefing(
      roleToolsTitle,
      'If instructed during onboarding, connect or add your official work email to Gmail. Send a quick test message to confirm that your linked address is working properly.',
    ),
  ),
  self(
    'email-signature',
    'Add a professional email signature',
    'Add a simple signature with your name, job title, company name and approved contact details.',
    'What should I include in my professional email signature?',
    briefing(
      roleToolsTitle,
      'Set up a simple email signature in Gmail with your full name, job title, company name and approved contact details. Keep the formatting clean so it appears on every work email you send.',
    ),
  ),
  checked(
    'gsheet-daily-updates',
    'Understand how to do daily updates in GSheet',
    'Update your tasks honestly and clearly, including progress, completed work and any issue that needs help.',
    'How should I record my daily updates in GSheet?',
    briefing(
      roleToolsTitle,
      'Record your daily updates in GSheet honestly and clearly. Include your current progress, any completed work, and any issue or blocker where you need help from your team.',
    ),
    checks.gsheetDailyUpdates,
  ),
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
const teamSupport = [
  self(
    'company-chat-groups',
    'Join company chat groups',
    'Join the company-wide chat groups shared by the onboarding coordinator for work announcements and communication.',
    'How do I join the company-wide chat groups?',
    briefing(
      peopleSupportTitle,
      'Join the company-wide chat groups shared by your onboarding coordinator. Use these groups to stay updated on company announcements and general work communication.',
    ),
  ),
  self(
    'department-chat-group',
    'Join the respective department’s chat group',
    'Join the chat group for your department so you can receive team updates and communicate with colleagues about work.',
    'How do I join my department’s chat group?',
    briefing(
      peopleSupportTitle,
      'Join the chat group for your department so you can receive team updates and coordinate daily work with your colleagues. Ask your onboarding coordinator if you have not received the invite link yet.',
    ),
  ),
  self(
    'talent-personality-test',
    'Complete the Talent Personality Test',
    'Complete the Talent Personality Test (https://www.personalityhub.net/enneagram-test) if assigned and share the result with your onboarding contact if requested.',
    'How do I complete the Talent Personality Test?',
    briefing(
      peopleSupportTitle,
      'Complete the Talent Personality Test on the Personality Hub Enneagram page if it has been assigned to you. Follow the instructions provided and share your result with the designated onboarding contact if requested.',
    ),
  ),
  self(
    'mbti-personality-test',
    'Complete the MBTI Personality Test',
    'Complete the MBTI Personality Test (https://www.16personalities.com/free-personality-test) if assigned as a conversation starter for working preferences.',
    'How do I complete the MBTI Personality Test, and how is the result used?',
    briefing(
      peopleSupportTitle,
      'Complete the free MBTI Personality Test on 16Personalities if it has been assigned to you. The result is used as a friendly conversation starter to understand working preferences and is never treated as a test of ability.',
    ),
  ),
  workingPreferences,
];
// Documentation is the same for every track: three documents the employee saves.
const documentation = [
  hrVerify(
    'tax-id-documents',
    'Pass over a copy of your IC (front and back)',
    'Upload a clear copy of the front and back of your IC.',
    'How do I submit a copy of my IC?',
    briefing(
      null,
      'Upload a clear copy of the front and back of your IC. The task is complete once your document is saved. HR reviews documents separately.',
    ),
  ),
  hrVerify(
    'personal-bank-details',
    'Add your details into the Employees/Interns Record',
    'Upload your completed details for the Employees/Interns Record.',
    'How do I add my details to the Employees/Interns Record?',
    briefing(
      null,
      'Upload your completed details for the Employees and Interns Record. The task is complete once your document is saved. HR reviews documents separately.',
    ),
  ),
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

// Starter content pack (issue #86, Option A). Company-neutral, four required
// steps per area, no check steps and no company facts in the text.
export const starterTemplateVersion = 1;

const starterDocumentationEmployee = [
  hrVerify(
    'contract',
    'Sign your employment contract',
    'Review and sign your employment contract, then mark it as submitted. HR verifies it.',
    'How do I sign my employment contract?',
    briefing(
      null,
      'Review your employment contract carefully, checking your role, start date, compensation and terms before signing. Once signed and submitted, HR verifies your contract.',
    ),
  ),
  hrVerify(
    'personal-bank-details',
    'Submit your personal and bank details',
    'Provide your personal, banking and tax information for payroll setup. HR verifies them.',
    'What personal and bank details do I need to submit?',
    briefing(
      null,
      'Submit your personal contact information and the bank account details where your salary should be paid. HR verifies your details for payroll setup.',
    ),
  ),
  hrVerify(
    'tax-id-documents',
    'Submit your ID and tax documents',
    'Provide your identity card or passport and relevant tax documents. HR verifies them.',
    'What ID and tax documents do I need to submit?',
    briefing(
      null,
      'Provide a valid identification document such as your identity card or passport, along with any relevant tax documents or numbers. HR verifies them.',
    ),
  ),
  hrVerify(
    'emergency-contact',
    'Submit your emergency contact details',
    'Provide the contact information for someone to reach in an emergency. HR verifies it.',
    'How do I submit my emergency contact details?',
    briefing(
      null,
      'Provide the name, relationship and phone number of a trusted emergency contact who can be reached if an urgent situation arises. HR verifies your details.',
    ),
  ),
];

const starterDocumentationIntern = [
  hrVerify(
    'contract',
    'Sign your internship agreement',
    'Review and sign your internship agreement, then mark it as submitted. HR verifies it.',
    'How do I sign my internship agreement?',
    briefing(
      null,
      'Review your internship agreement covering your internship period, stipend and learning objectives before signing. Once signed and submitted, HR verifies it.',
    ),
  ),
  starterDocumentationEmployee[1],
  starterDocumentationEmployee[2],
  starterDocumentationEmployee[3],
];

const starterDocumentationContractor = [
  hrVerify(
    'contract',
    'Sign your service agreement',
    'Review and sign your service agreement, then mark it as submitted. HR verifies it.',
    'How do I sign my service agreement?',
    briefing(
      null,
      'Review your service agreement outlining the scope of work, deliverables, engagement terms and fees before signing. Once signed and submitted, HR verifies it.',
    ),
  ),
  hrVerify(
    'personal-bank-details',
    'Submit your billing and bank details',
    'Provide your billing details and bank account for payment processing. HR verifies them.',
    'Which billing and bank details do I need to submit?',
    briefing(
      null,
      'Provide your billing details, tax identification and bank account information for invoice processing. HR verifies these details upon submission.',
    ),
  ),
  hrVerify(
    'tax-id-documents',
    'Submit your identification document',
    'Provide a copy of your identity card or passport. HR verifies it.',
    'What identification document do I need to submit?',
    briefing(
      null,
      'Provide a copy of your valid identity card or passport to verify your identity for contractor records. HR verifies the document.',
    ),
  ),
  hrVerify(
    'confidentiality-agreement',
    'Sign the confidentiality agreement (NDA)',
    'Sign the non-disclosure and confidentiality agreement. HR verifies it.',
    'What does the confidentiality agreement cover?',
    briefing(
      null,
      'The confidentiality agreement protects confidential company information, customer data and intellectual property. Sign and submit it for HR verification.',
    ),
  ),
];

const starterPolicies = [
  self(
    'company-rules',
    'Company rules and workplace expectations',
    'Review company guidelines, working hours and general workplace conduct.',
    'What are the company rules and working hours?',
    briefing(
      null,
      'Read and understand the company policies regarding working hours, workplace expectations and attendance. Reach out to HR or your manager if you have questions.',
    ),
  ),
  self(
    'conduct-safety',
    'Workplace conduct & security safety',
    'Learn how we maintain a safe, respectful environment and protect systems and data.',
    'What should I know about workplace conduct and security?',
    briefing(
      null,
      'Treat colleagues with respect and adhere to workplace safety standards. Keep passwords private, follow account security guidelines, and report suspicious activities promptly.',
    ),
  ),
  self(
    'data-privacy',
    'Privacy & data handling',
    'Understand how customer and company data must be safeguarded.',
    'How should I handle sensitive and personal data?',
    briefing(
      null,
      'Customer and internal company information is confidential. Only access and use data necessary for your role, and protect it according to applicable privacy standards.',
    ),
  ),
  self(
    'responsible-ai',
    'Responsible AI use',
    'Learn approved AI practices and what information must never be shared.',
    'Which AI tools am I allowed to use at work?',
    briefing(
      null,
      'Use only approved AI tools in accordance with company guidance. Never input confidential data, passwords or proprietary source code into unapproved AI tools.',
    ),
  ),
];

const starterAlignment = [
  self(
    'company-overview',
    'What the company does',
    'Learn what the company builds, its products and who its customers are.',
    'What does the company do, and who are our customers?',
    briefing(
      null,
      'Learn about the company, its core products and services, and the customers we serve. Ask Alya about the company overview to learn key facts from the company profile.',
    ),
  ),
  self(
    'purpose-values',
    'Purpose, mission and values',
    'Understand the company’s purpose, vision and guiding principles.',
    'What are the company’s mission, vision and values?',
    briefing(
      null,
      'Learn about our mission, vision and the core values that guide how we work and make decisions. Ask Alya to explore the values listed in the company profile.',
    ),
  ),
  self(
    'team-structure',
    'Team and department structure',
    'Get to know the departments across the company and how teams collaborate.',
    'How do teams and departments work together?',
    briefing(
      null,
      'Understand how different departments and teams collaborate across the organization. Check the company contacts in your profile to see who leads each function.',
    ),
  ),
  self(
    'your-contribution',
    'How your role contributes',
    'Understand how your daily work connects to team and company goals.',
    'How does my role contribute to company goals?',
    briefing(
      null,
      'Understand how your responsibilities fit into your team and the broader organization, helping achieve shared goals and milestones.',
    ),
  ),
];

const starterRoleTools = [
  self(
    'work-accounts',
    'Set up work accounts & credentials',
    'Activate your company email and core system accounts.',
    'How do I set up my work accounts?',
    briefing(
      null,
      'Log into your primary work email and communication platforms. Follow setup prompts to enable two-factor authentication for enhanced security.',
    ),
  ),
  self(
    'shared-files',
    'Access shared files and documentation',
    'Locate team documentation, templates and shared drives.',
    'Where do I find team documentation and shared files?',
    briefing(
      null,
      'Confirm access to shared team folders, drives and knowledge bases. Familiarize yourself with key documentation and guides relevant to your role.',
    ),
  ),
  self(
    'communication-tools',
    'Set up communication tools',
    'Join team chat channels and collaboration spaces.',
    'Which communication tools and channels should I join?',
    briefing(
      null,
      'Set up your messaging tools, join key team and department channels, and introduce yourself to your teammates.',
    ),
  ),
  self(
    'ai-readiness-training',
    'AI readiness training',
    'Complete the introductory AI training to learn effective practices.',
    'What is the AI readiness training?',
    briefing(
      null,
      'Complete the self-assessment and initial learning module on utilizing AI tools safely, effectively and productively in your role.',
    ),
  ),
];

const starterTeamSupport = [
  self(
    'meet-manager',
    'Meet with your manager',
    'Have an initial check-in meeting with your manager to align on goals and expectations.',
    'What should I discuss with my manager in our first meeting?',
    briefing(
      null,
      'Schedule a meeting with your manager to review initial priorities, 30-day goals, communication preferences and any questions you have.',
    ),
  ),
  self(
    'team-channels',
    'Connect with team channels',
    'Learn where questions, announcements and daily updates are shared.',
    'Where are daily team updates and announcements shared?',
    briefing(
      null,
      'Get oriented with team check-ins, standup channels and where team members share progress and ask for assistance.',
    ),
  ),
  self(
    'who-to-ask',
    'Know who to ask for help',
    'Learn how to get support for IT, HR and operational questions.',
    'Who should I contact for help with HR or IT issues?',
    briefing(
      null,
      'Identify point persons for IT support, HR inquiries and office facilities so you know where to reach out when you need assistance.',
    ),
  ),
  self(
    'meet-colleagues',
    'Meet colleagues and teammates',
    'Schedule short introductory chats with team members and key collaborators.',
    'How can I connect with my teammates?',
    briefing(
      null,
      'Introduce yourself to colleagues within and across teams to understand their roles and begin building strong collaborative working relationships.',
    ),
  ),
  {
    ...self(
      'working-preferences',
      'Share your working preferences or support needs (optional)',
      'Tell your manager or HR how you prefer to work or about any support you need. This never affects your progress.',
      'How can I share my working preferences or support needs?',
      null,
    ),
    required: false,
  },
];

const starterStepsByTrack = {
  employee: {
    documentation: starterDocumentationEmployee,
    policies: starterPolicies,
    alignment: starterAlignment,
    'role-tools': starterRoleTools,
    'team-support': starterTeamSupport,
  },
  intern: {
    documentation: starterDocumentationIntern,
    policies: starterPolicies,
    alignment: starterAlignment,
    'role-tools': starterRoleTools,
    'team-support': starterTeamSupport,
  },
  contractor: {
    documentation: starterDocumentationContractor,
    policies: starterPolicies,
    alignment: starterAlignment,
    'role-tools': starterRoleTools,
    'team-support': starterTeamSupport,
  },
};

export function starterTemplate(track = defaultTrack) {
  const chosen = tracks.includes(track) ? track : defaultTrack;
  return {
    track: chosen,
    version: starterTemplateVersion,
    threshold: completionThreshold,
    areas: areaOrder.map((areaId) => ({
      id: areaId,
      icon: areaText[areaId].icon,
      title: areaText[areaId].title,
      description: areaText[areaId].description,
      steps: starterStepsByTrack[chosen][areaId].map(({ slug, briefing: brief, ...step }) => ({
        id: `${areaId}.${slug}`,
        ...step,
        briefing: brief ? { ...brief } : null,
      })),
    })),
  };
}
