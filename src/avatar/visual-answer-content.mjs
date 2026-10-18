// Presentation only: keep every word of the answer and never invent a task,
// policy, time, or completion signal from a user's reading interactions.
export function visualAnswer(message) {
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!text) return null;
  const grounded =
    message.mode !== 'demo' && Array.isArray(message.passages) && message.passages.length > 0;
  const example = message.learning?.format === 'example';
  let kind = 'reply',
    items = [text];
  if (grounded) {
    const markers = [...text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s+/g)];
    const ordered =
      markers.length > 1 &&
      markers.length <= 8 &&
      markers[0].index === 0 &&
      markers.every((m, i) => Number(m[1]) === i + 1);
    if (ordered) {
      items = markers.map((m, i) =>
        text.slice(m.index + m[0].length, markers[i + 1]?.index ?? text.length).trim(),
      );
      // A numbered list of facts is still a set of facts. Show a task flow
      // only when each item is phrased as an explicit action.
      kind = items.every((body) =>
        /^(?:Please\s+)?(?:Ask|Open|Send|Prepare|Ensure|Check|Submit|Claim|Read|Complete|Attend|Log|Sign|Go|Visit|Create|Share|Keep|Confirm|Contact|Review|Bring|Download|Upload|Fill|Select|Choose|Wait|Write|Add|Set|Update|Report|Use|Follow|Schedule|Request|Join|Inform|Be|Register|Meet)\b/i.test(
          body,
        ),
      )
        ? 'steps'
        : example
          ? 'example'
          : 'points';
    } else {
      kind = example ? 'example' : 'points';
      const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
      const parts =
        paragraphs.length > 1
          ? paragraphs
          : text.split(/(?<=[.!?])\s+(?=[A-Z“"\d])/).filter(Boolean);
      if (parts.length <= 6) items = parts;
    }
  }
  return {
    text,
    kind,
    example,
    grounded,
    items: items.map((body, index) => ({
      body,
      index,
      label: visualLabel(body),
      icon: visualIcon(body),
      ...visualSubject(body),
      plain: grounded ? simpleAnswer(body) : body,
    })),
  };
}

// Topic labels and artwork describe the words in the answer. They do not
// determine permission, eligibility, task completion, or employee ability.
function visualSubject(text) {
  const times = [
    ...new Set(text.match(/\b\d{1,2}(?:[.:]\d{2})?\s*(?:[ap]\.m\.?|[ap]m)(?![a-z])/gi) || []),
  ].slice(0, 4);
  if (
    /\b(work updates?|progress reports?)\b/i.test(text) &&
    /\b(prepare|share|submit|include)\b/i.test(text)
  )
    return { scene: 'document', title: 'Prepare your update' };
  if (/\bEnglish\b/i.test(text) && /\b(communicate|use|required)\b/i.test(text))
    return { scene: 'conversation', title: 'Meeting language', tag: 'English' };
  if (
    /\b(round table|discussion)\b/i.test(text) &&
    /\b(questions?|suggestions?|issues?|challenges?)\b/i.test(text)
  )
    return { scene: 'conversation', title: 'Questions & ideas' };
  if (
    /\b(HR|Human Resources)\b/i.test(text) &&
    /\b(confirm|check|contact|ask|details)\b/i.test(text)
  )
    return { scene: 'people', title: 'Check with HR' };
  if (/\b(receipts?|mileage|claim)\b/i.test(text))
    return {
      scene: 'document',
      title: /\b(mileage)\b/i.test(text) ? 'Mileage guidance' : 'Receipts & claims',
    };
  if (/\b(wear|clothing|shirts?|jeans|pants|slippers|dress code|dress guidance)\b/i.test(text)) {
    const clothes = [];
    if (/\bcollared\b/i.test(text)) clothes.push('collared');
    else if (/\b(?:t-?shirts?|shirts?)\b/i.test(text)) clothes.push('shirt');
    if (/\bjeans\b/i.test(text)) clothes.push('jeans');
    if (/\bshort (?:hot )?pants\b/i.test(text)) clothes.push('shorts');
    if (/\bslippers\b/i.test(text)) clothes.push('slippers');
    const names = {
      collared: 'Collared T-shirts',
      shirt: 'T-shirts',
      jeans: 'Jeans',
      shorts: 'Short pants',
      slippers: 'Slippers',
    };
    return {
      scene: 'clothing',
      title: /\b(not allowed|not permitted|prohibited)\b/i.test(text)
        ? /\bweekdays\b/i.test(text)
          ? 'Weekday restrictions'
          : 'Clothing restrictions'
        : clothes.length === 1
          ? names[clothes[0]]
          : 'Clothing rules',
      clothes: clothes.slice(0, 3),
      ripped: /\bripped jeans\b/i.test(text),
    };
  }
  if (
    times.length ||
    /\b(working hours|office hours|hours of work|work schedule|breaks?)\b/i.test(text)
  )
    return {
      scene: 'time',
      title: /\b(vary|discretion|changes?)\b/i.test(text)
        ? 'Schedule changes'
        : /\bOn Fridays?\b/i.test(text) && /\b(lunch|break)\b/i.test(text)
          ? 'Friday breaks'
          : 'Hours & schedule',
      times,
    };
  if (
    /\b(virtual reality|augmented reality|gamification|metaverses?)\b/i.test(text) &&
    /\b(focus|company|UniVRse|Luna Digital|Luna|develop|speciali[sz])\b/i.test(text)
  )
    return { scene: 'company', title: 'What the company does' };
  if (/\b(virtual|3D)\b/i.test(text) && /\b(events?|world)\b/i.test(text))
    return { scene: 'company', title: 'Virtual experiences' };
  if (/\b(meetings?|agenda)\b/i.test(text)) return { scene: 'meeting', title: 'Meeting guidance' };
  if (/\b(apps?|email|laptop|software|password|login|log in|sign in)\b/i.test(text))
    return { scene: 'computer', title: 'Tools & access' };
  if (/\b(manager|team|people|HR|human resources)\b/i.test(text))
    return { scene: 'people', title: 'People & support' };
  return { scene: 'document', title: visualLabel(text) };
}

export function simpleAnswer(text) {
  const wording = text.replace(/\s+/g, ' ').trim();
  const plainInstructions = new Map([
    ['Share their Work Breakdown or task list.', 'Share your work breakdown or task list.'],
    [
      'Briefly explain the tasks completed during the week.',
      'Briefly explain what you completed this week.',
    ],
    [
      'Show the progress percentage (%) for each project or assigned task.',
      'Show the progress percentage for each project or assigned task.',
    ],
    [
      'Applications for leave must be made online and send via email.',
      'Apply for leave online and send your application by email.',
    ],
    [
      'All staff who want to leave must inform and update in advance the latest tasks to person in charge before the day or date him/her on leave.',
      'Before taking leave, update the person covering your work on your latest tasks.',
    ],
    [
      'Please discuss and arrange among each other before apply for leave.',
      'Discuss arrangements with each other before applying for leave.',
    ],
  ]);
  const exact = plainInstructions.get(wording.replace(/^[●•]\s*/, ''));
  if (exact) return exact;
  const schedule = wording.match(
    /^The workweek is generally from Monday through Friday, with normal operating hours from (.+?) to (.+?), with one hour for lunch\.$/i,
  );
  if (schedule)
    return `Work is usually Monday–Friday, ${schedule[1]} to ${schedule[2]}; lunch is one hour.`;
  const friday = wording.match(
    /^Only on Friday the Muslim male employees are allowed a two-hour lunch break from (.+?) to (.+?), whereas male non-muslim, and female employees are allocated a one-hour lunch break\.$/i,
  );
  if (friday)
    return `On Friday only, Muslim male employees have a two-hour lunch break: ${friday[1]} to ${friday[2]}; non-Muslim male employees and female employees have a one-hour lunch break.`;
  if (
    /^The above working hours may be varied at Management’s absolute discretion\.$/i.test(wording)
  )
    return 'Management may change these working hours.';
  if (/^The current Company dress code is smart casual\.$/i.test(wording))
    return 'The dress code is smart casual.';
  const clothing = wording.match(
    /^Employees should be neatly and properly dress(?:ed|es) during office hours,\s*(.+) are not allowed in the office on weekdays\.$/i,
  );
  if (clothing)
    return `Dress neatly during office hours. ${clothing[1][0].toUpperCase() + clothing[1].slice(1)} are not allowed on weekdays.`;
  if (
    /^For female employees, culottes \(women[’']s knee-length trousers, cut with very full legs to resemble a skirt\), short, [‘']hot pants[’'] or revealing dress are also not to be worn in the office\.$/i.test(
      wording,
    )
  )
    return 'Female employees must also avoid culottes (wide-legged, knee-length trousers), shorts, hot pants and revealing dresses in the office.';
  // Narrow, complete grammatical rewrites only. Unrecognised policy wording
  // stays intact; never clip a sentence or drop a qualification for brevity.
  if (
    /^If you need more specific details about company operations, please confirm with the Human Resources Department\.$/i.test(
      text,
    )
  )
    return 'For more company details, check with HR.';
  if (
    /\b(only|unless|except|before|after|without|not|approval|if|provided that|as long as)\b/i.test(
      text,
    )
  )
    return text;
  return text
    .replace(
      /^Ensure you communicate in (\w+), as all participants are required to use \1 throughout the meeting\.$/i,
      'Use $1 throughout the meeting.',
    )
    .replace(/^Prepare your (.+) to share during the (.+)\.$/i, 'Prepare your $1 for the $2.')
    .replace(
      /^Be ready to participate in the round table discussion by bringing up any (.+)\.$/i,
      'Bring $1 to the round table discussion.',
    )
    .replace(
      /^As part of its business activities, (UniVRse|Luna Digital) provides /i,
      '$1 provides ',
    )
    .replace(
      /^(UniVRse Interactive Sdn Bhd|Luna Digital Sdn Bhd|Luna Digital) focuses on /i,
      '$1 focuses on ',
    );
}

export function presentationGuide(message) {
  const guide = visualAnswer(message);
  if (!guide) return null;
  const items = guide.items.map((item) => ({ ...item, body: item.plain }));
  return { ...guide, items, text: items.map((item) => item.body).join('\n\n') };
}

// Topic headings stay stable as the spoken point changes. They are labels,
// not shortened policy sentences or invented instructions.
export function visualTopicTitle(message) {
  const topics = [
    [/\b(wear|dress|attire|clothes|clothing|outfit|smart casual)\b/i, 'Office attire'],
    [/\b(lunch|breaks?)\b/i, 'Break times'],
    [
      /\b(working hours|office hours|hours of work|workweek|work schedule|what time)\b/i,
      'Working hours',
    ],
    [/\b(meetings?|agenda|work updates?)\b/i, 'Meeting preparation'],
    [/\b(leave|holidays?|absence|time off)\b/i, 'Leave & time off'],
    [/\b(password|accounts?|log ?in|laptop|software|email|IT access)\b/i, 'Tools & access'],
    [/\b(expenses?|claims?|receipts?|mileage|reimbursement)\b/i, 'Expenses & claims'],
    [/\b(first.day|first.week|orientation|induction)\b/i, 'Getting started'],
    [/\b(safety|emergency|evacuation|fire)\b/i, 'Workplace safety'],
    [/\b(HR|manager|team|support|contact)\b/i, 'People & support'],
    [/\b(company|mission|vision|values|business)\b/i, 'About the company'],
  ];
  for (const context of [
    message.referenceQuestion,
    message.passages?.map((passage) => passage.heading).join(' '),
    message.text,
  ]) {
    const match = topics.find(([pattern]) => pattern.test(context || ''));
    if (match) return match[1];
  }
  return 'Company guidance';
}

// Brief labels identify each point without truncating its actual instruction.
export function visualPointLabel(item) {
  const body = item.body || '';
  const labels = [
    [/\bFemale employees must also avoid\b/i, 'Additional rules'],
    [/\b(not allowed|not permitted|prohibited)\b/i, 'What to avoid'],
    [/\b(unless|except|only if|approval)\b/i, 'Conditions to check'],
    [/\b(HR|Human Resources)\b/i, 'Who can help'],
    [/\bsmart casual\b/i, 'Dress code'],
    [/\b(clean|neat|neatly)\b/i, 'Everyday clothing'],
    [/\bFriday\b/i, 'Friday arrangements'],
    [/\b(lunch|break)\b/i, 'Your break'],
    [/\b(Monday|workweek|working hours|operating hours)\b/i, 'Regular hours'],
    [/\b(change|vary|discretion)\b/i, 'Possible changes'],
    [/\b(password|account|log ?in|software|IT)\b/i, 'Access & setup'],
    [/\b(English|language)\b/i, 'Meeting language'],
    [/\b(work updates?|progress reports?)\b/i, 'Prepare your update'],
    [/\b(questions?|suggestions?|discussion)\b/i, 'Questions & ideas'],
    [/\b(agenda|prepare|bring|read)\b/i, 'What to prepare'],
    [/\b(receipt|claim|mileage)\b/i, 'Claims & receipts'],
    [/\b(leave|holiday|absence)\b/i, 'Leave guidance'],
  ];
  return (
    labels.find(([pattern]) => pattern.test(body))?.[1] ||
    (item.title && item.title.length <= 26 ? item.title : `Key point ${item.index + 1}`)
  );
}

function visualIcon(text) {
  if (/\b(wear|clothing|shirts?|t-shirts?|jeans|pants|slippers|dress)\b/i.test(text))
    return 'shirt';
  if (/\b(hours?|time|morning|daily)\b/i.test(text)) return 'clock';
  if (/\b(meetings?|events?|calendar)\b/i.test(text)) return 'calendar';
  if (/\b(wear|clothing|shirts?|dress)\b/i.test(text)) return 'shirt';
  if (/\b(receipts?|reports?|claims?)\b/i.test(text)) return 'receipt';
  if (/\b(apps?|email|laptop|software|password|login)\b/i.test(text)) return 'laptop';
  if (/\b(HR|manager|team|people|human resources)\b/i.test(text)) return 'people';
  if (/\b(chat|communicate|discussion|English)\b/i.test(text)) return 'chat';
  return 'book';
}

export function visualLabel(text) {
  const words = text.trim().split(/\s+/),
    label = words.slice(0, 7).join(' ');
  return label.length > 56
    ? label.slice(0, 53).trimEnd() + '…'
    : words.length > 7
      ? label + '…'
      : label;
}
