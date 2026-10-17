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
// Every track has exactly four required steps per area; a track substitutes
// steps rather than dropping them. Optional steps (required: false) never count.
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
export const templateVersion = 3;
// Every area must reach this percent of its required steps (contract v1.2).
export const completionThreshold = 70;
export const briefingMaxLength = 400;
export const writtenAnswerMaxLength = 600;
export const handbookTitle = 'UniVRse - Employee Handbook';
export const checklistTitle = 'UniVRse - New Staff Checklist';
export const orientationTitle = 'UniVRse - Orientation & Office Tour Guide';
export const contractTitle = 'UniVRse - Signing Your Employment Contract';
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
      'It is a Friday and you have no client meetings or events. Which outfit fits the dress code?',
    options: [
      { id: 'q4m7', text: 'Denim shorts, a plain T-shirt and clean sneakers' },
      { id: 'z2k9', text: 'A gym tracksuit, a plain T-shirt and running shoes' },
      { id: 'h8t3', text: 'Long jeans, a plain T-shirt and clean sneakers' },
    ],
    correctOptionId: 'h8t3',
    explanation:
      'Casual Friday allows long jeans, plain or tasteful T-shirts and clean sneakers. Short pants of any kind, including denim shorts, are not allowed on any working day, and sportswear is only for company sports events.',
  },
  conduct: {
    type: 'choice',
    scenario:
      'An email that says it is from IT asks you to reply with your password so your account can be “verified”. What should you do?',
    options: [
      { id: 'w5n1', text: 'Forward it to it-help@univrse.example, then delete it' },
      { id: 'c3x8', text: 'Reply with your password so that IT can verify you' },
      { id: 'p9v2', text: 'Open the link in it to check that the request is real' },
    ],
    correctOptionId: 'w5n1',
    explanation:
      'Never share your password, including with IT: IT will never ask for it. Forward suspicious emails to it-help@univrse.example and do not click their links or open their attachments.',
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
      'I would decline and keep the customer list in our company systems, working on it there with my UniVRse account. Customer data is confidential and may be used only to do our jobs, so it must never be copied to personal devices or accounts.',
    explanation:
      'Customer data is confidential. It may be used only to do your job and must never be copied to personal devices or accounts, during or after your employment.',
    maxLength: writtenAnswerMaxLength,
  },
  ai: {
    type: 'written',
    scenario:
      'You are stuck on a bug and would like an AI tool to explain some UniVRse source code. A friend recommends a free AI chatbot. What do you do? Answer in two or three sentences.',
    keyPoints: [
      {
        id: 'kp-approved-tool',
        text: 'Uses only an approved AI tool, such as Alya or Gemini in their UniVRse company account, or asks IT before using any other tool.',
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
      'I would not paste the code into the free chatbot, because source code must never go into an AI tool that IT has not approved. Instead I would ask Alya or Gemini in my UniVRse account, or check with IT first if I need a different tool.',
    explanation:
      'Use only approved AI tools, such as Alya and Gemini in your UniVRse account. Never paste customer data, payslips or source code into an AI tool that IT has not approved.',
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
  personalityTest: {
    type: 'choice',
    sourceTitle: peopleSupportTitle,
    scenario:
      'Your onboarding coordinator asks you about the Talent Personality Test. How should you approach this test and what should you do with the outcome?',
    options: [
      {
        id: 't5q2',
        text: 'Complete the assigned questions and send your summary to your onboarding contact',
      },
      {
        id: 'b8k4',
        text: 'Retake the personality test repeatedly until you achieve a senior manager profile',
      },
      {
        id: 'w1m9',
        text: 'Publish your personal profile score in the main company chat for all to review',
      },
    ],
    correctOptionId: 't5q2',
    explanation:
      'Complete the Talent Personality Test honestly according to the instructions, and share the result with your designated onboarding contact if requested.',
  },
  mbtiTest: {
    type: 'choice',
    sourceTitle: peopleSupportTitle,
    scenario:
      'A colleague asks you why new joiners are invited to take the MBTI Personality Test. What is the main purpose of this exercise at UniVRse?',
    options: [
      {
        id: 'p2r8',
        text: 'Treat the score as an official evaluation of your career skills and prospects',
      },
      {
        id: 'f4n7',
        text: 'Use the result as an informal starting point to discuss teamwork preferences',
      },
      {
        id: 'h9k3',
        text: 'Require every teammate to match your own personality type before starting tasks',
      },
    ],
    correctOptionId: 'f4n7',
    explanation:
      'The MBTI Personality Test is an optional conversation starter to help colleagues understand how they prefer to communicate and collaborate. It is never an evaluation of capability or performance.',
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

// Every track has exactly four REQUIRED steps per area (the 70% rule is then
// 3 of 4 everywhere); interns and contractors substitute steps instead of
// dropping them. Optional steps never count.
const policies = [
  checked(
    'employee-handbook',
    'Company rules (Employee Handbook)',
    'Read the Employee Handbook, especially working hours and dress code, then answer a short scenario.',
    'What does the Employee Handbook say about the dress code?',
    briefing(
      handbookTitle,
      'Our dress code is smart casual from Monday to Thursday. On casual Friday, long jeans, plain T-shirts and clean sneakers are fine. Short pants of any kind are not allowed on any working day, and sportswear is only for company sports events. If you are unsure about an outfit, ask your manager or People and Culture first.',
    ),
    checks.handbook,
  ),
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
      'UniVRse handles personal data in line with Malaysia’s Personal Data Protection Act 2010. Customer data, prices, source code and business plans are confidential, during and after your employment. Use customer data only to do your job, and never copy it to a personal device or a personal account.',
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
      'Use only approved AI tools, such as Alya and Gemini in your UniVRse account. Never paste customer data, payslips or source code into an AI tool that IT has not approved. If you think you need a different tool, ask IT first.',
    ),
    checks.ai,
  ),
];
const alignment = [
  self(
    'products-customers',
    'What the company does',
    'Learn what we build and who our customers are.',
    'What does the company do, and who are our customers?',
    briefing(
      handbookTitle,
      'UniVRse builds booking and scheduling software for clinics, salons and wellness studios in Malaysia and Singapore. Our two products are UniVRse Book, for bookings and scheduling, and UniVRse Pay, for payments. About 2,400 businesses use them today.',
    ),
  ),
  self(
    'mission-values',
    'Mission, values and goals',
    'Learn what the company stands for, the values we work by and this year’s goals.',
    'What are the company’s mission, values and goals?',
    briefing(
      handbookTitle,
      'Our mission is to help small service businesses spend less time on admin and more time with their customers. We work by four values: clear over clever, own it, help first, and respect how people work. This year’s company goals are presented in the company introduction on your first day.',
    ),
  ),
  self(
    'org-structure',
    'How teams fit together',
    'Get to know the departments and how they work together.',
    'How do the departments work together?',
    briefing(
      handbookTitle,
      'UniVRse has six departments: Product and Engineering, Customer Success, Sales and Marketing, Finance, People and Culture, and Operations and Facilities. In your first month, try to meet one person from each department. Fifteen minutes with each of them is enough.',
    ),
  ),
  self(
    'role-contribution',
    'How your role contributes',
    'Understand how your work supports the company’s goals.',
    'How does my role contribute to the company’s goals?',
    briefing(
      handbookTitle,
      'Everything we do helps small service businesses spend less time on admin and more time with their customers. Ask your manager how your work connects to this year’s company goals, and keep that link in mind when you plan your first tasks.',
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
  self(
    'ai-readiness-training',
    'Complete your AI Readiness self-assessment and practice task',
    'Rate your AI experience from 1 to 10 (or skip the rating) to get a tailored learning path and complete a quick practice task.',
    'How does the AI proficiency self-assessment work, and what training should I complete?',
    briefing(
      roleToolsTitle,
      'Rate your AI experience from 1 to 10, or skip the rating if you are not sure yet. Alya will give you a tailored beginner, intermediate, or advanced learning path with a short practice exercise. Complete that practice exercise to finish this step.',
    ),
  ),
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
  checked(
    'talent-personality-test',
    'Complete the Talent Personality Test',
    'Complete the Talent Personality Test (https://www.personalityhub.net/enneagram-test) if assigned and share the result with your onboarding contact if requested.',
    'How do I complete the Talent Personality Test?',
    briefing(
      peopleSupportTitle,
      'Complete the Talent Personality Test on the Personality Hub Enneagram page if it has been assigned to you. Follow the instructions provided and share your result with the designated onboarding contact if requested.',
    ),
    checks.personalityTest,
  ),
  checked(
    'mbti-personality-test',
    'Complete the MBTI Personality Test',
    'Complete the MBTI Personality Test (https://www.16personalities.com/free-personality-test) if assigned as a conversation starter for working preferences.',
    'How do I complete the MBTI Personality Test, and how is the result used?',
    briefing(
      peopleSupportTitle,
      'Complete the free MBTI Personality Test on 16Personalities if it has been assigned to you. The result is used as a friendly conversation starter to understand working preferences and is never treated as a test of ability.',
    ),
    checks.mbtiTest,
  ),
  workingPreferences,
];
const emergencyContact = hrVerify(
  'emergency-contact',
  'Submit your emergency contact form',
  'Add an emergency contact in UniVRse HR, under My Profile. HR verifies it.',
  'How do I add my emergency contact?',
  briefing(
    checklistTitle,
    'Add an emergency contact in UniVRse HR, under My Profile, if you have not done so already. The New Staff Checklist asks you to do this in your first week. Once it is there, mark this step as submitted and HR verifies it.',
  ),
);
const stepsByTrack = {
  employee: {
    documentation: [
      hrVerify(
        'contract',
        'Sign your employment contract',
        'Sign your contract electronically in UniVRse HR, then mark it as submitted. HR verifies it.',
        'How do I sign my employment contract?',
        briefing(
          contractTitle,
          'You sign your employment contract electronically in UniVRse HR, within 5 working days of receiving it. Before you sign, check your job title, start date, salary, probation period and work location, and ask People and Culture if anything looks wrong. A signed copy is emailed to you, and HR then verifies it.',
        ),
      ),
      hrVerify(
        'personal-bank-details',
        'Submit your personal and bank details',
        'Fill in the onboarding form with your bank, EPF and tax details. HR verifies it.',
        'What details do I need for the onboarding form?',
        briefing(
          contractTitle,
          'The onboarding form in UniVRse HR asks for your IC or passport number, home address, bank account, EPF number, income tax number and an emergency contact. Please finish it before your first day, so that your account, laptop and pay are ready. HR verifies the details once you submit them.',
        ),
      ),
      hrVerify(
        'tax-id-documents',
        'Show your tax and ID documents',
        'Bring your original IC or passport, certificates and tax numbers on day 1. HR verifies them.',
        'Which documents do I bring on my first day?',
        briefing(
          contractTitle,
          'On your first day, People and Culture checks your original documents at 9:15 in the morning. Bring your MyKad or passport, your highest education certificate and transcript, a bank statement or bank card, and your EPF and income tax numbers if you have them. HR then verifies them.',
        ),
      ),
      emergencyContact,
    ],
    policies,
    alignment,
    'role-tools': roleTools,
    'team-support': teamSupport,
  },
};

// Interns: the same steps, with intern wording in documentation.
stepsByTrack.intern = {
  ...stepsByTrack.employee,
  documentation: [
    hrVerify(
      'contract',
      'Sign your internship agreement',
      'Sign your internship agreement in UniVRse HR, then mark it as submitted. HR verifies it.',
      'How do I sign my internship agreement?',
      briefing(
        contractTitle,
        'Interns sign an internship agreement, not the employment contract. It sets out your monthly allowance, your internship dates and the benefits for interns. Sign it electronically in UniVRse HR, and ask People and Culture if anything is unclear. HR then verifies it.',
      ),
    ),
    hrVerify(
      'personal-bank-details',
      'Submit your personal and bank details',
      'Fill in the onboarding form with the bank details your allowance is paid to. HR verifies it.',
      'What details do I need for the onboarding form?',
      briefing(
        contractTitle,
        'Fill in the onboarding form in UniVRse HR with your personal details, an emergency contact and the bank account your allowance is paid to. Please finish it before your first day. HR verifies the details once you submit them.',
      ),
    ),
    hrVerify(
      'tax-id-documents',
      'Show your ID and placement documents',
      'Bring your original IC or passport, your university placement letter and insurance form on day 1. HR verifies them.',
      'Which documents do interns bring on the first day?',
      briefing(
        contractTitle,
        'On your first day, People and Culture checks your original documents at 9:15 in the morning. Bring your MyKad or passport, your university placement letter and your insurance form. HR then verifies them.',
      ),
    ),
    emergencyContact,
  ],
};

// Contractors: substitutes for the documentation steps that do not apply (an
// employment contract, payroll forms), while sharing the standard policies,
// alignment, role-tools, and team-support steps.
stepsByTrack.contractor = {
  documentation: [
    hrVerify(
      'contract',
      'Sign your service agreement',
      'Sign the service agreement for your engagement, then mark it as submitted. HR verifies it.',
      'How do I sign my service agreement?',
      briefing(
        null,
        'Your service agreement sets out the terms of your engagement with UniVRse. Read it carefully, and ask People and Culture about anything that is unclear before you sign. Once you mark it as submitted, HR verifies it.',
      ),
    ),
    hrVerify(
      'personal-bank-details',
      'Submit your billing and bank details',
      'Give HR the billing details and bank account your invoices are paid to. HR verifies them.',
      'Which billing and bank details does HR need from me?',
      briefing(
        null,
        'HR needs your billing details and the bank account your invoices are paid to. Check that they match your service agreement before you submit them. HR then verifies them.',
      ),
    ),
    hrVerify(
      'tax-id-documents',
      'Show your ID document',
      'Show your IC or passport so your building access can be set up. HR verifies it.',
      'Which ID document do I need to show?',
      briefing(
        orientationTitle,
        'Show your MyKad or passport so that your building access can be set up. On your first day, register with the lobby guard using your IC, and from day 2 use your UniVRse access card at the lobby gates. HR verifies your document.',
      ),
    ),
    hrVerify(
      'confidentiality-agreement',
      'Sign the confidentiality agreement (NDA)',
      'Sign the confidentiality agreement that covers customer data, prices and source code. HR verifies it.',
      'What does the confidentiality agreement cover?',
      briefing(
        handbookTitle,
        'The confidentiality agreement covers customer data, prices, source code and business plans. Keep them confidential during and after your engagement, and use customer data only to do your work. HR verifies the signed agreement.',
      ),
    ),
  ],
  policies,
  alignment,
  'role-tools': roleTools,
  'team-support': teamSupport,
};

// The template document for a track, as stored in onboardingTemplates/{track}.
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
      description: areaText[areaId].description,
      steps: stepsByTrack[chosen][areaId].map(({ slug, check, briefing: brief, ...step }) => ({
        id: `${areaId}.${slug}`,
        ...step,
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
