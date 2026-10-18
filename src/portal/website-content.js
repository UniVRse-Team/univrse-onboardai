// Editable portal content. Activities are suggestions, not HR assignments.
export const navigation = [
  { path: '/onboarding', label: 'My onboarding', short: 'Journey', icon: 'checklist' },
  { path: '/support', label: 'People & support', short: 'People', icon: 'people' },
  { path: '/alya', label: 'Ask Alya', short: 'Alya', icon: 'spark' },
];
export const supportTeams = [
  {
    id: 'manager',
    title: 'Your manager & buddy',
    subtitle: 'Your first point of contact',
    icon: 'people',
    color: 'mint',
    topics: ['Role & priorities', 'Team introductions', 'First-week arrangements'],
    instruction: 'Ask HR to confirm your reporting manager and whether a buddy has been assigned.',
  },
  {
    id: 'hr',
    title: 'Human Resources',
    subtitle: 'Your people team',
    icon: 'heart',
    color: 'pink',
    topics: ['Onboarding activities', 'Employment documents', 'Workplace questions'],
    instruction: 'Use the approved HR channel. Your manager can help you find the current contact.',
  },
  {
    id: 'it',
    title: 'IT support',
    subtitle: 'Get connected, stay connected',
    icon: 'laptop',
    color: 'violet',
    topics: ['Accounts & access', 'Equipment', 'Technical problems'],
    instruction: 'Ask your manager for the IT support contact or approved helpdesk link.',
  },
  {
    id: 'accounts',
    title: 'Accounts & finance',
    subtitle: 'Help with approved expenses',
    icon: 'receipt',
    color: 'amber',
    topics: ['Claim forms', 'Required receipts', 'Reimbursement process'],
    instruction:
      'Ask your manager for the authorised Accounts contact before sharing financial documents.',
  },
];
