// Best-effort PII removal for knowledge gaps (issue #49). Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactPersonalData } from '../../server/pii-redaction.mjs';
import { gapDocument, groupGaps, normaliseTopic } from '../../server/knowledge-gaps.mjs';
import { DEFAULT_COMPANY_ID } from '../../server/companies.mjs';

test('emails are removed', () => {
  assert.equal(
    redactPersonalData('Can I email avery.example+hr@example.co.my about parking?'),
    'Can I email [email] about parking?',
  );
  assert.equal(redactPersonalData('A@B.IO and c_d@e-f.example.org'), '[email] and [email]');
});

test('Malaysian phone numbers (+60, 01x mobiles, 0x landlines) and international numbers are removed', () => {
  for (const phone of [
    '+60 12-345 6789',
    '+6012-3456789',
    '+60123456789',
    '012-345 6789',
    '0123456789',
    '011-2345 6789',
    '03-1234 5678',
    '(03) 1234 5678',
    '07 123 4567',
    '+65 5550 0101',
    '+1 (555) 010-0199',
  ])
    assert.equal(
      redactPersonalData(`Call me on ${phone} please`),
      'Call me on [phone] please',
      phone,
    );
});

test('Malaysian IC numbers are removed with or without dashes', () => {
  for (const ic of ['900101-14-5678', '900101145678', '900101 14 5678'])
    assert.equal(redactPersonalData(`My IC is ${ic}.`), 'My IC is [IC number].', ic);
});

test('Employee IDs such as PC-0001 are removed, in any letter case', () => {
  assert.equal(
    redactPersonalData('I am PC-0001 and my buddy is sm-0012; HR-0001 approved it'),
    'I am [employee ID] and my buddy is [employee ID]; [employee ID] approved it',
  );
});

test('ordinary onboarding questions keep their numbers, dates, times and amounts', () => {
  for (const text of [
    'Is the office open from 0730 to 2100 on 2026-11-02?',
    'Can I claim RM1,500 for 3 days of travel at RM0.60 per km?',
    'What happens in week 12 of probation, and is ext. 201 People & Culture?',
    'Does the 40-hour week include the 1-hour lunch?',
    '',
  ])
    assert.equal(redactPersonalData(text), text);
  assert.equal(redactPersonalData(undefined), '');
});

test('a gap document holds the redacted question, topic, track, nearest source and day only', () => {
  const doc = gapDocument(
    {
      question: 'Where do I park? Text me on 012-345 6789 or avery@example.com, I am PC-0001',
      topic: '  Parking for PC-0001 ',
      track: 'intern',
      nearestSource: { title: 'Synthetic handbook', heading: 'Parking' },
    },
    new Date('2026-10-15T23:30:00Z'),
  );
  assert.deepEqual(doc, {
    questionRedacted: 'Where do I park? Text me on [phone] or [email], I am [employee ID]',
    topic: 'parking for [employee id]',
    track: 'intern',
    nearestSource: { title: 'Synthetic handbook', heading: 'Parking' },
    companyId: DEFAULT_COMPANY_ID,
    createdDay: '2026-10-16', // the company's calendar day (UTC+8), no time
  });
  assert.deepEqual(
    Object.keys(gapDocument({ question: 'x', topic: '', track: 'nope' }, new Date())).sort(),
    ['companyId', 'createdDay', 'nearestSource', 'questionRedacted', 'topic', 'track'],
  );
  assert.equal(normaliseTopic(''), 'other');
  assert.equal(gapDocument({ question: 'x', track: 'nope' }, new Date()).track, 'employee');
});

test('gaps group by topic, highest count first, with at most three recent examples', () => {
  const gap = (topic, day, question, track = 'employee', title = 'Synthetic handbook') => ({
    questionRedacted: question,
    topic,
    track,
    nearestSource: title ? { title, heading: 'H' } : null,
    createdDay: day,
  });
  const groups = groupGaps([
    gap('parking', '2026-10-01', 'Where do I park?'),
    gap('Parking', '2026-10-03', 'Is parking free?', 'intern'),
    gap('parking', '2026-10-02', 'Where do I park?', 'contractor', 'Other guide'),
    gap('parking', '2026-10-04', 'Can I park a motorbike?', 'intern', null),
    gap('gym', '2026-10-05', 'Is there a gym?'),
  ]);
  assert.deepEqual(groups, [
    {
      topic: 'parking',
      count: 4,
      lastSeenDay: '2026-10-04',
      examples: ['Can I park a motorbike?', 'Is parking free?', 'Where do I park?'],
      tracks: { employee: 1, intern: 2, contractor: 1 },
      nearestSources: [
        { title: 'Synthetic handbook', heading: 'H' },
        { title: 'Other guide', heading: 'H' },
      ],
    },
    {
      topic: 'gym',
      count: 1,
      lastSeenDay: '2026-10-05',
      examples: ['Is there a gym?'],
      tracks: { employee: 1, intern: 0, contractor: 0 },
      nearestSources: [{ title: 'Synthetic handbook', heading: 'H' }],
    },
  ]);
});
