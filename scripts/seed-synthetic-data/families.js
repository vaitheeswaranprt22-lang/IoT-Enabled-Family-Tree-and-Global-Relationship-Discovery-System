/**
 * SYNTHETIC / DEMONSTRATION DATA
 *
 * Every person in this file is invented. No real family information is used.
 *
 * The dataset is designed to exercise the system's hard cases, not just its
 * happy path:
 *
 *   SHARED ANCESTOR ACROSS TREES
 *     Arjun (tree A) and Priya (tree B) each independently recorded the same
 *     great-grandparents, Venkatesh and Lakshmi Raghavan. The two trees are
 *     NOT connected at seed time. The duplicate-detection scan finds them, and
 *     only after a human approves the merge do Arjun and Priya become
 *     discoverable as second cousins. That is the end-to-end demonstration.
 *
 *   SIMILAR NAMES THAT MUST NOT MATCH
 *     "Ramesh Iyer" born 1963 in Madurai (tree B) and "Ramesh Iyer" born 1981
 *     in Bangalore (tree C) share a name and nothing else. Their exact dates
 *     of birth conflict and their parents differ, so the engine must suppress
 *     the pair rather than offer it as a likely match.
 *
 *   DUPLICATE WITHIN ONE TREE
 *     Arjun entered his grandmother twice, as "Meenakshi Raghavan" and
 *     "Meenakshi R". Same date of birth, same birthplace, same spouse.
 *
 *   NON-BIOLOGICAL RELATIONSHIPS
 *     A step-parent (tree D), an adoption (tree C) and a cross-tree marriage
 *     (Anthony D'Souza to Neha Sharma) so that in-law and adoptive paths can
 *     be told apart from blood paths.
 *
 *   AN UNCONNECTED TREE
 *     The Okafor family (tree E) shares no ancestor with anyone, so
 *     "no relationship path found" can be demonstrated honestly.
 */

export const DEMO_PASSWORD = 'DemoPassword#2026';

/** Deceased ancestors are public; living people default to family-only. */
const vis = (deathDate) => (deathDate ? 'public' : 'family');

const p = (key, given, family, gender, birth, birthPlace, death = null, extra = {}) => ({
  key,
  given_name: given,
  family_name: family,
  gender,
  birth_date: birth,
  birth_place: birthPlace,
  death_date: death,
  is_living: death ? 0 : 1,
  visibility: extra.visibility ?? vis(death),
  ...extra,
});

// ===========================================================================
//  TREE A -- Raghavan family, Chennai.  Account holder: Arjun Raghavan
// ===========================================================================
export const treeA = {
  user: {
    key: 'arjun',
    email: 'arjun@demo.familytree.local',
    displayName: 'Arjun Raghavan',
    selfPersonKey: 'a_arjun',
  },
  persons: [
    // Generation 1 -- great-grandparents (ALSO present in tree B).
    p('a_venkatesh', 'Venkatesh', 'Raghavan', 'male', '1908-06-14', 'Thanjavur, Tamil Nadu', '1984-03-02',
      { occupation: 'Schoolteacher' }),
    p('a_lakshmi', 'Lakshmi', 'Raghavan', 'female', '1912-11-30', 'Kumbakonam, Tamil Nadu', '1991-07-19',
      { maiden_name: 'Sundaram' }),

    // Generation 2 -- grandparents.
    p('a_subramanian', 'Subramanian', 'Raghavan', 'male', '1935-02-18', 'Thanjavur, Tamil Nadu', '2008-05-11',
      { occupation: 'Railway engineer' }),
    p('a_meenakshi', 'Meenakshi', 'Raghavan', 'female', '1940-09-05', 'Chennai, Tamil Nadu', '2015-01-23',
      { maiden_name: 'Krishnan' }),
    // Deliberate duplicate of the record above, entered a second time.
    p('a_meenakshi_dup', 'Meenakshi', 'R', 'female', '1940-09-05', 'Chennai, Tamil Nadu', '2015-01-23',
      { notes: 'Entered from an old photograph album; may be the same person as Meenakshi Raghavan.' }),

    // Generation 3 -- parents.
    p('a_murugan', 'Murugan', 'Raghavan', 'male', '1962-04-12', 'Chennai, Tamil Nadu', null,
      { occupation: 'Bank manager', current_place: 'Chennai, Tamil Nadu' }),
    p('a_devi', 'Devi', 'Raghavan', 'female', '1966-08-21', 'Coimbatore, Tamil Nadu', null,
      { maiden_name: 'Natarajan', occupation: 'Headmistress' }),

    // Generation 4 -- the account holder and siblings.
    p('a_arjun', 'Arjun', 'Raghavan', 'male', '1992-07-03', 'Chennai, Tamil Nadu', null,
      { occupation: 'Software engineer', current_place: 'Chennai, Tamil Nadu' }),
    p('a_kavitha', 'Kavitha', 'Raghavan', 'female', '1995-12-15', 'Chennai, Tamil Nadu', null,
      { occupation: 'Architect' }),
    p('a_nisha', 'Nisha', 'Raghavan', 'female', '1994-02-27', 'Chennai, Tamil Nadu', null,
      { maiden_name: 'Venkataraman' }),

    // Generation 5.
    p('a_aditya', 'Aditya', 'Raghavan', 'male', '2019-05-09', 'Chennai, Tamil Nadu'),
  ],
  relationships: [
    ['a_venkatesh', 'spouse', 'a_lakshmi', 'married', { startDate: '1932-05-20' }],
    ['a_venkatesh', 'parent', 'a_subramanian', 'biological'],
    ['a_lakshmi', 'parent', 'a_subramanian', 'biological'],
    ['a_subramanian', 'spouse', 'a_meenakshi', 'married', { startDate: '1960-11-14' }],
    ['a_subramanian', 'parent', 'a_murugan', 'biological'],
    ['a_meenakshi', 'parent', 'a_murugan', 'biological'],
    ['a_murugan', 'spouse', 'a_devi', 'married', { startDate: '1990-02-08' }],
    ['a_murugan', 'parent', 'a_arjun', 'biological'],
    ['a_devi', 'parent', 'a_arjun', 'biological'],
    ['a_murugan', 'parent', 'a_kavitha', 'biological'],
    ['a_devi', 'parent', 'a_kavitha', 'biological'],
    ['a_arjun', 'spouse', 'a_nisha', 'married', { startDate: '2017-12-03' }],
    ['a_arjun', 'parent', 'a_aditya', 'biological'],
    ['a_nisha', 'parent', 'a_aditya', 'biological'],
  ],
  events: [
    ['a_venkatesh', 'occupation', 'Appointed headmaster of the village school', '1948-06-01', 'Thanjavur, Tamil Nadu'],
    ['a_subramanian', 'migration', 'Moved the family from Thanjavur to Chennai', '1959-08-15', 'Chennai, Tamil Nadu'],
    ['a_murugan', 'graduation', 'Graduated in commerce', '1983-04-22', 'Chennai, Tamil Nadu'],
    ['a_arjun', 'graduation', 'Graduated in computer science', '2014-05-30', 'Chennai, Tamil Nadu'],
  ],
};

// ===========================================================================
//  TREE B -- Iyer family, Madurai.  Account holder: Priya Iyer
//  Shares Venkatesh and Lakshmi with tree A, recorded independently.
// ===========================================================================
export const treeB = {
  user: {
    key: 'priya',
    email: 'priya@demo.familytree.local',
    displayName: 'Priya Iyer',
    selfPersonKey: 'b_priya',
  },
  persons: [
    // The SAME two people as a_venkatesh / a_lakshmi, entered separately.
    // Small differences in how the place was written are intentional: real
    // duplicates rarely agree character for character.
    p('b_venkatesh', 'Venkatesh', 'Raghavan', 'male', '1908-06-14', 'Thanjavur', '1984-03-02',
      { occupation: 'Teacher', notes: 'My great-grandfather on my father’s mother’s side.' }),
    p('b_lakshmi', 'Lakshmi', 'Raghavan', 'female', '1912-11-30', 'Kumbakonam', '1991-07-19'),

    p('b_kamala', 'Kamala', 'Iyer', 'female', '1938-03-27', 'Thanjavur, Tamil Nadu', '2012-10-08',
      { maiden_name: 'Raghavan' }),
    p('b_ganesan', 'Ganesan', 'Iyer', 'male', '1934-01-15', 'Madurai, Tamil Nadu', '2009-06-30',
      { occupation: 'Temple priest' }),

    p('b_ramesh', 'Ramesh', 'Iyer', 'male', '1963-10-08', 'Madurai, Tamil Nadu', null,
      { occupation: 'Civil servant', current_place: 'Madurai, Tamil Nadu' }),
    p('b_shanthi', 'Shanthi', 'Iyer', 'female', '1968-05-19', 'Tiruchirappalli, Tamil Nadu', null,
      { maiden_name: 'Balasubramanian' }),
    p('b_anitha', 'Anitha', 'Iyer', 'female', '1967-02-14', 'Madurai, Tamil Nadu', null,
      { occupation: 'Doctor' }),

    p('b_priya', 'Priya', 'Iyer', 'female', '1993-09-21', 'Madurai, Tamil Nadu', null,
      { occupation: 'Data analyst', current_place: 'Bengaluru, Karnataka' }),
    p('b_vikram', 'Vikram', 'Iyer', 'male', '1996-03-04', 'Madurai, Tamil Nadu', null,
      { occupation: 'Teacher' }),
  ],
  relationships: [
    ['b_venkatesh', 'spouse', 'b_lakshmi', 'married', { startDate: '1932-05-20' }],
    ['b_venkatesh', 'parent', 'b_kamala', 'biological'],
    ['b_lakshmi', 'parent', 'b_kamala', 'biological'],
    ['b_kamala', 'spouse', 'b_ganesan', 'married', { startDate: '1961-04-09' }],
    ['b_kamala', 'parent', 'b_ramesh', 'biological'],
    ['b_ganesan', 'parent', 'b_ramesh', 'biological'],
    ['b_kamala', 'parent', 'b_anitha', 'biological'],
    ['b_ganesan', 'parent', 'b_anitha', 'biological'],
    ['b_ramesh', 'spouse', 'b_shanthi', 'married', { startDate: '1991-06-16' }],
    ['b_ramesh', 'parent', 'b_priya', 'biological'],
    ['b_shanthi', 'parent', 'b_priya', 'biological'],
    ['b_ramesh', 'parent', 'b_vikram', 'biological'],
    ['b_shanthi', 'parent', 'b_vikram', 'biological'],
  ],
  events: [
    ['b_kamala', 'marriage', 'Married Ganesan Iyer at the Meenakshi temple', '1961-04-09', 'Madurai, Tamil Nadu'],
    ['b_priya', 'migration', 'Moved to Bengaluru for work', '2016-07-11', 'Bengaluru, Karnataka'],
  ],
};

// ===========================================================================
//  TREE C -- Sharma family, Delhi.  Account holder: Rohit Sharma
//  Contains the deliberate "similar name, different person" record and an
//  adoption. Connects to tree D through a marriage that is already verified.
// ===========================================================================
export const treeC = {
  user: {
    key: 'rohit',
    email: 'rohit@demo.familytree.local',
    displayName: 'Rohit Sharma',
    selfPersonKey: 'c_rohit',
  },
  persons: [
    p('c_hari', 'Hari', 'Sharma', 'male', '1930-01-20', 'Lucknow, Uttar Pradesh', '2005-09-14'),
    p('c_sushila', 'Sushila', 'Sharma', 'female', '1934-07-11', 'Kanpur, Uttar Pradesh', '2011-02-27'),

    p('c_vijay', 'Vijay', 'Sharma', 'male', '1958-11-03', 'Delhi', null, { occupation: 'Civil engineer' }),
    p('c_radha', 'Radha', 'Sharma', 'female', '1961-04-25', 'Delhi', null, { maiden_name: 'Bhatt' }),
    p('c_sunita', 'Sunita', 'Iyer', 'female', '1963-09-02', 'Delhi', null,
      { maiden_name: 'Bhatt', notes: 'Radha’s younger sister.' }),

    // SIMILAR NAME, DIFFERENT PERSON.
    // Shares a name with b_ramesh, but was born 18 years later, in another
    // city, to different parents. The matching engine must NOT rank this as a
    // likely duplicate: the exact dates of birth conflict decisively.
    p('c_ramesh_iyer', 'Ramesh', 'Iyer', 'male', '1981-10-08', 'Bengaluru, Karnataka', null,
      { occupation: 'Pilot', notes: 'SYNTHETIC TEST CASE: same name as Ramesh Iyer in the Iyer tree, different person.' }),

    p('c_rohit', 'Rohit', 'Sharma', 'male', '1988-06-17', 'Delhi', null,
      { occupation: 'Product designer', current_place: 'Delhi' }),
    p('c_neha', 'Neha', 'Sharma', 'female', '1991-01-08', 'Delhi', null, { occupation: 'Journalist' }),

    // Adopted child -- exercises the adoptive subtype.
    p('c_aarav', 'Aarav', 'Sharma', 'male', '2015-03-19', 'Delhi'),
  ],
  relationships: [
    ['c_hari', 'spouse', 'c_sushila', 'married', { startDate: '1955-02-11' }],
    ['c_hari', 'parent', 'c_vijay', 'biological'],
    ['c_sushila', 'parent', 'c_vijay', 'biological'],
    ['c_vijay', 'spouse', 'c_radha', 'married', { startDate: '1986-12-07' }],
    ['c_vijay', 'parent', 'c_rohit', 'biological'],
    ['c_radha', 'parent', 'c_rohit', 'biological'],
    ['c_vijay', 'parent', 'c_neha', 'biological'],
    ['c_radha', 'parent', 'c_neha', 'biological'],
    // Sunita is Radha's sister; the shared parents are not recorded, so an
    // explicit sibling edge is the honest representation.
    ['c_radha', 'sibling', 'c_sunita', 'full'],
    ['c_sunita', 'parent', 'c_ramesh_iyer', 'biological'],
    // Adoption.
    ['c_vijay', 'parent', 'c_aarav', 'adoptive'],
    ['c_radha', 'parent', 'c_aarav', 'adoptive'],
  ],
  events: [
    ['c_hari', 'migration', 'Moved from Lucknow to Delhi after partition', '1952-11-03', 'Delhi'],
    ['c_aarav', 'adoption', 'Adoption finalised', '2016-08-24', 'Delhi'],
    ['c_neha', 'graduation', 'Graduated in journalism', '2012-06-15', 'Delhi'],
  ],
};

// ===========================================================================
//  TREE D -- D'Souza family, Goa.  Account holder: Maria D'Souza
//  Connects to tree C by marriage (already verified) and contains a
//  step-parent relationship.
// ===========================================================================
export const treeD = {
  user: {
    key: 'maria',
    email: 'maria@demo.familytree.local',
    displayName: "Maria D'Souza",
    selfPersonKey: 'd_maria',
  },
  persons: [
    p('d_francisco', 'Francisco', "D'Souza", 'male', '1932-05-08', 'Panaji, Goa', '2010-12-19',
      { occupation: 'Fisherman' }),
    p('d_rosa', 'Rosa', "D'Souza", 'female', '1936-12-01', 'Margao, Goa', '2018-04-06'),

    p('d_joseph', 'Joseph', "D'Souza", 'male', '1960-03-14', 'Panaji, Goa', null, { occupation: 'Hotelier' }),
    p('d_teresa', 'Teresa', "D'Souza", 'female', '1963-08-30', 'Vasco da Gama, Goa', null,
      { maiden_name: 'Pereira' }),
    // Teresa's first husband -- their daughter has Joseph as a step-father.
    p('d_paulo', 'Paulo', 'Fernandes', 'male', '1958-07-21', 'Margao, Goa', null),
    p('d_lucia', 'Lucia', 'Fernandes', 'female', '1985-10-12', 'Margao, Goa', null, { occupation: 'Nurse' }),

    p('d_maria', 'Maria', "D'Souza", 'female', '1990-11-22', 'Panaji, Goa', null,
      { occupation: 'Marine biologist', current_place: 'Panaji, Goa' }),
    p('d_anthony', 'Anthony', "D'Souza", 'male', '1987-02-09', 'Panaji, Goa', null, { occupation: 'Chef' }),
  ],
  relationships: [
    ['d_francisco', 'spouse', 'd_rosa', 'married', { startDate: '1957-01-26' }],
    ['d_francisco', 'parent', 'd_joseph', 'biological'],
    ['d_rosa', 'parent', 'd_joseph', 'biological'],
    ['d_teresa', 'spouse', 'd_paulo', 'divorced', { startDate: '1984-02-18', endDate: '1988-09-30' }],
    ['d_teresa', 'parent', 'd_lucia', 'biological'],
    ['d_paulo', 'parent', 'd_lucia', 'biological'],
    ['d_joseph', 'spouse', 'd_teresa', 'married', { startDate: '1989-05-27' }],
    ['d_joseph', 'parent', 'd_maria', 'biological'],
    ['d_teresa', 'parent', 'd_maria', 'biological'],
    ['d_joseph', 'parent', 'd_anthony', 'biological'],
    ['d_teresa', 'parent', 'd_anthony', 'biological'],
  ],
  events: [
    ['d_francisco', 'occupation', 'Bought his first fishing boat', '1961-03-02', 'Panaji, Goa'],
    ['d_maria', 'graduation', 'Doctorate in marine biology', '2018-09-14', 'Goa'],
  ],
};

// ===========================================================================
//  TREE E -- Okafor family, Lagos.  Account holder: Chidi Okafor
//  Deliberately shares no ancestor with any other tree, so the system can
//  demonstrate an honest "no relationship path found".
// ===========================================================================
export const treeE = {
  user: {
    key: 'chidi',
    email: 'chidi@demo.familytree.local',
    displayName: 'Chidi Okafor',
    selfPersonKey: 'e_chidi',
  },
  persons: [
    p('e_emeka', 'Emeka', 'Okafor', 'male', '1940-02-11', 'Enugu, Nigeria', '2014-06-08'),
    p('e_ngozi', 'Ngozi', 'Okafor', 'female', '1944-09-25', 'Onitsha, Nigeria', '2020-01-17'),
    p('e_obi', 'Obi', 'Okafor', 'male', '1968-12-04', 'Lagos, Nigeria', null, { occupation: 'Lawyer' }),
    p('e_adaeze', 'Adaeze', 'Okafor', 'female', '1972-06-30', 'Lagos, Nigeria', null, { maiden_name: 'Eze' }),
    p('e_chidi', 'Chidi', 'Okafor', 'male', '1995-04-18', 'Lagos, Nigeria', null,
      { occupation: 'Electrical engineer', current_place: 'Lagos, Nigeria' }),
    p('e_amara', 'Amara', 'Okafor', 'female', '1998-08-07', 'Lagos, Nigeria', null, { occupation: 'Student' }),
  ],
  relationships: [
    ['e_emeka', 'spouse', 'e_ngozi', 'married', { startDate: '1966-03-19' }],
    ['e_emeka', 'parent', 'e_obi', 'biological'],
    ['e_ngozi', 'parent', 'e_obi', 'biological'],
    ['e_obi', 'spouse', 'e_adaeze', 'married', { startDate: '1993-11-06' }],
    ['e_obi', 'parent', 'e_chidi', 'biological'],
    ['e_adaeze', 'parent', 'e_chidi', 'biological'],
    ['e_obi', 'parent', 'e_amara', 'biological'],
    ['e_adaeze', 'parent', 'e_amara', 'biological'],
  ],
  events: [
    ['e_obi', 'graduation', 'Called to the bar', '1992-10-28', 'Lagos, Nigeria'],
  ],
};

export const ALL_TREES = [treeA, treeB, treeC, treeD, treeE];

/**
 * Relationships that span two trees. These already exist as verified edges at
 * seed time, so the system starts with one connected pair (Sharma/D'Souza) and
 * one pair waiting to be discovered (Raghavan/Iyer).
 */
export const CROSS_TREE_RELATIONSHIPS = [
  {
    from: 'c_neha',
    to: 'd_anthony',
    type: 'spouse',
    subtype: 'married',
    startDate: '2019-02-14',
    status: 'verified',
    note: 'Marriage between the Sharma and D’Souza families, confirmed by both tree owners.',
  },
];

/** Fingerprint enrolments, one per demonstration account that has one. */
export const ENROLLMENTS = [
  { userKey: 'arjun', deviceId: 'ESP32-LAB-01', slot: 1, label: 'Right index finger' },
  { userKey: 'priya', deviceId: 'ESP32-LAB-01', slot: 2, label: 'Right thumb' },
  { userKey: 'rohit', deviceId: 'ESP32-LAB-01', slot: 3, label: 'Left index finger' },
  { userKey: 'arjun', deviceId: 'ESP32-SIM-01', slot: 1, label: 'Simulated finger A' },
  { userKey: 'priya', deviceId: 'ESP32-SIM-01', slot: 2, label: 'Simulated finger B' },
  { userKey: 'maria', deviceId: 'ESP32-SIM-01', slot: 3, label: 'Simulated finger C' },
];

export const DEVICES = [
  {
    deviceId: 'ESP32-LAB-01',
    name: 'Lab Scanner (ESP32 + R307)',
    location: 'Project bench',
    simulated: false,
  },
  {
    deviceId: 'ESP32-SIM-01',
    name: 'Virtual Scanner (browser simulator)',
    location: 'Software only',
    simulated: true,
  },
];

/** Collaboration grants seeded so the permission model is visible immediately. */
export const COLLABORATIONS = [
  { owner: 'rohit', grantee: 'maria', role: 'editor', status: 'active',
    message: 'We share the Sharma-D’Souza branch, so you can edit it directly.' },
  { owner: 'maria', grantee: 'rohit', role: 'viewer', status: 'active',
    message: 'Have a look at the Goan side of the family.' },
  { owner: 'arjun', grantee: 'priya', role: 'viewer', status: 'pending',
    message: 'I think we may be related through the Raghavan side -- take a look?' },
];
