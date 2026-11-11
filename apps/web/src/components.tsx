import { useState, type FormEvent } from 'react';
import type { CarrierInfo, DocumentMeta, ErrorCode, StepTiming } from '@carrier-docs/contracts';
import { friendlyError } from './api.ts';
import { formatSeconds, statusText, type State } from './state.ts';

// Dumb views: props in, callbacks out. All state lives in the reducer (state.ts).

function submit(handler: () => void) {
  return (e: FormEvent) => {
    e.preventDefault();
    handler();
  };
}

export function ErrorLine({ code, message }: { code: ErrorCode; message?: string }) {
  return (
    <p className="error" role="alert">
      {friendlyError(code)} <code>{code}</code>
      {message ? <span className="detail"> {message}</span> : null}
    </p>
  );
}

export function AccessForm(props: {
  submitting: boolean;
  error?: string;
  onSubmit: (code: string) => void;
}) {
  // The access code is not a session secret worth keeping in global state; local is fine.
  const [code, setCode] = useState('');
  return (
    <form onSubmit={submit(() => props.onSubmit(code))}>
      <h2>Access code</h2>
      <p>This demo is private. Enter the access code you were given.</p>
      <label>
        Access code
        <input
          type="password"
          name="access-code"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </label>
      {props.error ? (
        <p className="error" role="alert">
          {props.error}
        </p>
      ) : null}
      <button type="submit" disabled={props.submitting || code === ''}>
        {props.submitting ? 'Checking...' : 'Continue'}
      </button>
    </form>
  );
}

export function carrierLabel(c: CarrierInfo): string {
  return c.isDemo ? `[DEMO] ${c.name} (test fixture, not a real carrier)` : c.name;
}

export function LoginForm(props: {
  state: State;
  onSelectCarrier: (id: string) => void;
  onField: (field: 'username' | 'password', value: string) => void;
  onSubmit: () => void;
  onRetryCarriers: () => void;
}) {
  const { state } = props;
  const carrier = state.carriers?.find((c) => c.id === state.carrierId);
  const canSubmit =
    !!carrier && state.username !== '' && state.password !== '' && !state.loginSubmitting;
  return (
    <form onSubmit={submit(props.onSubmit)}>
      <h2>Log in to your carrier</h2>
      {state.carriersError ? (
        <p className="error" role="alert">
          Could not load carriers: {state.carriersError}{' '}
          <button type="button" onClick={props.onRetryCarriers}>
            Retry
          </button>
        </p>
      ) : null}
      <label>
        Carrier
        <select
          name="carrier"
          value={state.carrierId}
          onChange={(e) => props.onSelectCarrier(e.target.value)}
          disabled={state.carriers === null}
          required
        >
          <option value="">{state.carriers === null ? 'Loading...' : 'Choose a carrier'}</option>
          {state.carriers?.map((c) => (
            <option key={c.id} value={c.id}>
              {carrierLabel(c)}
            </option>
          ))}
        </select>
      </label>
      {carrier?.isDemo ? (
        <p className="note">
          Demo carrier: a built-in test portal, not a real insurer. Do not use real credentials.
        </p>
      ) : null}
      <label>
        Username
        <input
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={state.username}
          onChange={(e) => props.onField('username', e.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={state.password}
          onChange={(e) => props.onField('password', e.target.value)}
          required
        />
      </label>
      {state.loginError ? (
        <ErrorLine code={state.loginError.code} message={state.loginError.message} />
      ) : null}
      <button type="submit" disabled={!canSubmit}>
        {state.loginSubmitting ? 'Starting...' : 'Get my documents'}
      </button>
    </form>
  );
}

export function MfaForm(props: {
  mfa: NonNullable<State['mfa']>;
  code: string;
  error?: State['mfaError'];
  onCode: (value: string) => void;
  onSubmit: () => void;
}) {
  const { mfa } = props;
  return (
    <form onSubmit={submit(props.onSubmit)}>
      <h2>Verification code</h2>
      <p>{mfa.hint ?? 'Your carrier sent you a verification code.'}</p>
      {mfa.lastAttemptRejected ? (
        <p className="error" role="alert">
          Code rejected. Check it and try again.
        </p>
      ) : null}
      <p>
        Attempts left: <strong>{mfa.attemptsLeft}</strong>
      </p>
      <label>
        Code
        <input
          name="one-time-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          value={props.code}
          onChange={(e) => props.onCode(e.target.value)}
          required
          autoFocus
        />
      </label>
      {props.error ? <ErrorLine code={props.error.code} message={props.error.message} /> : null}
      <button type="submit" disabled={props.code.trim() === ''}>
        Verify
      </button>
    </form>
  );
}

export function StatusPanel(props: {
  status?: State['status'];
  timings: StepTiming[];
  clientElapsedMs?: number;
  serverElapsedMs?: number;
  firstDocumentMs?: number;
}) {
  return (
    <section className="status" aria-live="polite">
      <h2>Status</h2>
      {props.firstDocumentMs !== undefined ? (
        <p className="headline" data-testid="headline">
          First document in {formatSeconds(props.firstDocumentMs)}
        </p>
      ) : null}
      <p>
        Now:{' '}
        <strong data-testid="status">{props.status ? statusText(props.status) : 'Starting'}</strong>
      </p>
      <p>
        Elapsed: {props.clientElapsedMs !== undefined ? formatSeconds(props.clientElapsedMs) : '-'}
        {props.serverElapsedMs !== undefined
          ? ` (server: ${formatSeconds(props.serverElapsedMs)})`
          : ''}
      </p>
      {props.timings.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {props.timings.map((t, i) => (
              <tr key={`${i}-${t.step}`}>
                <td>{t.step}</td>
                <td>{formatSeconds(t.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

const KIND_TEXT: Record<DocumentMeta['kind'], string> = {
  id_card: 'ID card',
  declarations: 'Declarations',
  policy: 'Policy',
  other: 'Other',
};

export function DocumentsView(props: {
  documents: DocumentMeta[];
  selectedId?: string;
  readyId?: string;
  documentUrl: (docId: string) => string;
  onSelect: (docId: string) => void;
}) {
  const selected = props.documents.find((d) => d.id === props.selectedId);
  return (
    <section>
      <h2>Your documents</h2>
      <ul className="docs">
        {props.documents.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              aria-pressed={d.id === props.selectedId}
              onClick={() => props.onSelect(d.id)}
            >
              {d.title}
            </button>{' '}
            <small>
              {KIND_TEXT[d.kind]}
              {d.policyNumberMasked ? `, policy ${d.policyNumberMasked}` : ''}
              {d.id === props.readyId ? ', ready' : ''}
            </small>
          </li>
        ))}
      </ul>
      {selected ? (
        <div className="viewer">
          <p>
            <a href={props.documentUrl(selected.id)} target="_blank" rel="noreferrer">
              Open {selected.title} in a new tab
            </a>
          </p>
          {/* key: a fresh frame per document, loaded only when selected (lazy). */}
          <iframe key={selected.id} title={selected.title} src={props.documentUrl(selected.id)} />
        </div>
      ) : (
        <p>Preparing the first document...</p>
      )}
    </section>
  );
}

export function FailedView(props: {
  failure: NonNullable<State['failure']>;
  onTryAgain: () => void;
}) {
  const { failure } = props;
  return (
    <section>
      <h2>That did not work</h2>
      <ErrorLine code={failure.code} message={failure.message} />
      {failure.retryable ? (
        <button type="button" onClick={props.onTryAgain}>
          Try again
        </button>
      ) : null}
    </section>
  );
}
