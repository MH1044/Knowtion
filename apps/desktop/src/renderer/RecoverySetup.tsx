import { useCallback, useEffect, useState } from 'react';

import { api, type KeyStatus, type PhraseChallenge } from './api.js';

/**
 * The recovery-phrase ceremony, shown before the workspace exists.
 *
 * ADR-0007 makes this mandatory and unskippable, and the reason is blunt enough to say
 * on screen: there is no backend, no account and no reset, so a lost phrase with a lost
 * keychain is a workspace nobody can ever open again. The wording here does not
 * reassure, because reassurance would be a lie.
 *
 * Nothing is written until the challenge is answered. The main process holds the phrase
 * and checks the answers itself, so this component cannot skip the step even if it is
 * rewritten carelessly later.
 */
export function RecoverySetup({
  status,
  onDone,
}: {
  status: KeyStatus;
  onDone: () => void;
}): React.JSX.Element {
  const [phrase, setPhrase] = useState<PhraseChallenge>();
  const [stage, setStage] = useState<'read' | 'confirm'>('read');
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setPhrase(await api.beginKeySetup());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, []);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.confirmKeySetup(answers);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [answers, onDone]);

  if (error !== undefined && phrase === undefined) {
    return (
      <div className="setup">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (phrase === undefined) return <div className="setup">Preparing your workspace…</div>;

  return (
    <div className="setup">
      <h1>Your recovery phrase</h1>

      {!status.secretsOsBacked && (
        <p className="warning">
          This computer has no secure place to keep your key — it is {status.protectorDescription}.
          Anything on this machine that can read your files can read your notes. Your recovery
          phrase matters more than usual here.
        </p>
      )}

      {stage === 'read' ? (
        <>
          <p>
            These 24 words are the only way back into your notes if this computer is lost or reset.
            Write them down on paper and keep them somewhere safe.
          </p>
          <p className="warning">
            Knowtion has no account and no server. Nobody — including us — can reset this for you.
            If you lose both this computer and these words, your notes are gone permanently.
          </p>

          <ol className="phrase">
            {phrase.words.map((word, index) => (
              <li key={`${String(index)}-${word}`}>
                <span className="ordinal">{index + 1}</span>
                <span className="word">{word}</span>
              </li>
            ))}
          </ol>

          <button
            type="button"
            onClick={() => {
              setStage('confirm');
            }}
          >
            I have written them down
          </button>
        </>
      ) : (
        <>
          <p>
            To be sure the copy you made is correct, type these words back. Check them against your
            paper rather than scrolling back.
          </p>

          <div className="challenge">
            {phrase.challenge.map((position, index) => (
              <label key={position}>
                <span>Word {position}</span>
                <input
                  value={answers[index] ?? ''}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    const next = [...answers];
                    next[index] = event.target.value;
                    setAnswers(next);
                  }}
                />
              </label>
            ))}
          </div>

          {error !== undefined && <p className="error">{error}</p>}

          <div className="actions">
            <button
              type="button"
              onClick={() => {
                setStage('read');
              }}
              disabled={busy}
            >
              Show the phrase again
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy || answers.some((a) => a.trim() === '')}
            >
              {busy ? 'Setting up…' : 'Confirm and open my workspace'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
