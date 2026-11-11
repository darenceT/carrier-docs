/** Fixture data for the mock portal. Everything here is obviously fake. */

export type MockDocumentKind = 'id_card' | 'declarations' | 'policy' | 'other';

export interface MockPolicy {
  id: string;
  line: 'Auto' | 'Renters';
  policyNumber: string;
  description: string;
}

export interface MockDocument {
  id: string;
  title: string;
  kind: MockDocumentKind;
  policyNumber: string;
  filename: string;
}

export const MOCK_INSURED_NAME = 'Pat Example';

export const MOCK_POLICIES: readonly MockPolicy[] = [
  {
    id: 'auto',
    line: 'Auto',
    policyNumber: 'DEMO-0000-1234',
    description: '2015 Example Motors Sedan (test fixture)',
  },
  {
    id: 'renters',
    line: 'Renters',
    policyNumber: 'DEMO-0000-5678',
    description: '123 Example Street, Apt 4, Testville (test fixture)',
  },
];

/** In display order: the auto ID card first, as on most real portals. */
export const MOCK_DOCUMENTS: readonly MockDocument[] = [
  {
    id: 'auto-id-card',
    title: 'Auto ID Card',
    kind: 'id_card',
    policyNumber: 'DEMO-0000-1234',
    filename: 'demo-auto-id-card.pdf',
  },
  {
    id: 'auto-declarations',
    title: 'Auto Declarations Page',
    kind: 'declarations',
    policyNumber: 'DEMO-0000-1234',
    filename: 'demo-auto-declarations.pdf',
  },
  {
    id: 'renters-declarations',
    title: 'Renters Declarations Page',
    kind: 'declarations',
    policyNumber: 'DEMO-0000-5678',
    filename: 'demo-renters-declarations.pdf',
  },
  {
    id: 'auto-policy-packet',
    title: 'Auto Policy Packet',
    kind: 'policy',
    policyNumber: 'DEMO-0000-1234',
    filename: 'demo-auto-policy-packet.pdf',
  },
];
