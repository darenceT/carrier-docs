import { useCallback, useEffect, useReducer } from 'react';
import { friendlyError, toApiError, type Api, type ApiError } from './api.ts';
import {
  AccessForm,
  DocumentsView,
  FailedView,
  LoginForm,
  MfaForm,
  StatusPanel,
} from './components.tsx';
import { openSessionEvents, type EventSourceFactory } from './events.ts';
import { initialState, reducer, screenOf } from './state.ts';

export interface Deps {
  api: Api;
  eventSource: EventSourceFactory;
}

export default function App({ deps }: { deps: Deps }) {
  const { api, eventSource } = deps;
  const [state, dispatch] = useReducer(reducer, initialState);
  const screen = screenOf(state);

  /** Every API failure goes through here: 401 means "show the access form". */
  const onApiError = useCallback((err: unknown, handle: (e: ApiError) => void) => {
    const e = toApiError(err);
    if (e.code === 'UNAUTHORIZED') dispatch({ type: 'access_required' });
    else handle(e);
  }, []);

  const loadCarriers = useCallback(() => {
    api
      .carriers()
      .then((r) => dispatch({ type: 'carriers_loaded', carriers: r.carriers }))
      .catch((err: unknown) =>
        onApiError(err, (e) =>
          dispatch({ type: 'carriers_failed', message: friendlyError(e.code) }),
        ),
      );
  }, [api, onApiError]);

  // Load carriers on start and again once access is granted.
  const needCarriers = !state.needsAccess && state.carriers === null && !state.carriersError;
  useEffect(() => {
    if (needCarriers) loadCarriers();
  }, [needCarriers, loadCarriers]);

  // One event stream per session; closed on start over, try again, forget me and unmount.
  const { sessionId } = state;
  useEffect(() => {
    if (!sessionId) return;
    return openSessionEvents(
      eventSource,
      api.eventsUrl(sessionId),
      (event) => dispatch(event),
      () => dispatch({ type: 'stream_lost' }),
    );
  }, [sessionId, api, eventSource]);

  // Live elapsed timer while the session runs.
  const running = !!sessionId && !state.finished;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 100);
    return () => clearInterval(timer);
  }, [running]);

  const prewarm = (carrierId: string) => {
    if (!carrierId) return;
    // Best effort: a failed prewarm only means a slower login.
    api
      .prewarm({ carrierId })
      .then((r) => dispatch({ type: 'prewarmed', carrierId, sessionId: r.sessionId }))
      .catch(() => {});
  };

  const onAccess = (code: string) => {
    dispatch({ type: 'access_submitted' });
    api
      .access(code)
      .then(() => dispatch({ type: 'access_granted' }))
      .catch((err: unknown) => {
        const e = toApiError(err);
        dispatch({
          type: 'access_failed',
          message:
            e.code === 'UNAUTHORIZED' || e.code === 'VALIDATION_FAILED'
              ? 'That access code is not valid.'
              : friendlyError(e.code),
        });
      });
  };

  const onSelectCarrier = (carrierId: string) => {
    dispatch({ type: 'carrier_selected', carrierId });
    prewarm(carrierId);
  };

  const onLogin = () => {
    const { carrierId, username, password, prewarmSessionId } = state;
    // Clears the password from state before the request is even in flight.
    dispatch({ type: 'login_submitted' });
    api
      .startSession({ carrierId, username, password, prewarmSessionId })
      .then((r) => dispatch({ type: 'session_started', sessionId: r.sessionId, at: Date.now() }))
      .catch((err: unknown) =>
        onApiError(err, (e) =>
          dispatch({ type: 'login_failed', error: { code: e.code, message: e.message } }),
        ),
      );
  };

  const onMfa = () => {
    if (!sessionId) return;
    const code = state.mfaCode.trim();
    dispatch({ type: 'mfa_submitted' });
    api
      .submitMfa(sessionId, { code })
      .then(() => dispatch({ type: 'mfa_accepted' }))
      .catch((err: unknown) =>
        onApiError(err, (e) =>
          dispatch({ type: 'mfa_post_failed', error: { code: e.code, message: e.message } }),
        ),
      );
  };

  const onTryAgain = () => {
    const { carrierId } = state;
    dispatch({ type: 'try_again' });
    prewarm(carrierId);
  };

  const onForget = () => {
    api
      .forgetMe()
      .then((r) => dispatch({ type: 'forgotten', deleted: r.deleted }))
      .catch((err: unknown) =>
        onApiError(err, (e) => dispatch({ type: 'forget_failed', message: friendlyError(e.code) })),
      );
  };

  return (
    <main>
      <header>
        <h1>Carrier Docs</h1>
        <nav>
          <button type="button" onClick={() => dispatch({ type: 'start_over' })}>
            Start over
          </button>{' '}
          <button type="button" onClick={onForget}>
            Forget me
          </button>
        </nav>
        {state.forgotten !== undefined ? (
          <p className="note" role="status">
            Forgotten: deleted {state.forgotten} saved session{state.forgotten === 1 ? '' : 's'}.
          </p>
        ) : null}
        {state.forgetError ? (
          <p className="error" role="alert">
            Forget me failed: {state.forgetError}
          </p>
        ) : null}
      </header>

      {screen === 'access' ? (
        <AccessForm
          submitting={state.accessSubmitting}
          error={state.accessError}
          onSubmit={onAccess}
        />
      ) : null}

      {screen === 'login' || screen === 'starting' ? (
        <LoginForm
          state={state}
          onSelectCarrier={onSelectCarrier}
          onField={(field, value) => dispatch({ type: 'field_changed', field, value })}
          onSubmit={onLogin}
          onRetryCarriers={loadCarriers}
        />
      ) : null}

      {screen === 'mfa' && state.mfa ? (
        <MfaForm
          mfa={state.mfa}
          code={state.mfaCode}
          error={state.mfaError}
          onCode={(value) => dispatch({ type: 'field_changed', field: 'mfaCode', value })}
          onSubmit={onMfa}
        />
      ) : null}

      {screen === 'waiting' ? <p>Working on it...</p> : null}

      {screen === 'documents' && sessionId ? (
        <DocumentsView
          documents={state.documents}
          selectedId={state.selectedDocumentId}
          readyId={state.readyDocumentId}
          documentUrl={(docId) => api.documentUrl(sessionId, docId)}
          onSelect={(documentId) => dispatch({ type: 'document_selected', documentId })}
        />
      ) : null}

      {screen === 'failed' && state.failure ? (
        <FailedView failure={state.failure} onTryAgain={onTryAgain} />
      ) : null}

      {sessionId ? (
        <StatusPanel
          status={state.status}
          timings={state.timings}
          clientElapsedMs={state.clientElapsedMs}
          serverElapsedMs={state.serverElapsedMs}
          firstDocumentMs={state.firstDocumentMs}
        />
      ) : null}
    </main>
  );
}
