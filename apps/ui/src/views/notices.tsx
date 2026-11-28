// The notices strip (#43): failures and main's notices, bottom right over every view.

import type { JSX } from 'preact';
import { dismiss, notices } from '../state/notices.ts';
import type { Notice } from '../state/notices.ts';

export function Notices(): JSX.Element | null {
    const list: readonly Notice[] = notices.value;
    if (list.length === 0) {
        return null;
    }
    return (
        <div class="notices" role="status" aria-live="polite">
            {list.map((n: Notice) => (
                <div key={n.id} class={`notice-item ${n.level}`} role={n.level === 'error' ? 'alert' : undefined}>
                    <span class="notice-text">{n.message}</span>
                    {n.action !== null && (
                        <button
                            type="button"
                            class="btn small-btn"
                            onClick={() => {
                                dismiss(n.id);
                                n.action?.run();
                            }}
                        >
                            {n.action.label}
                        </button>
                    )}
                    <button
                        type="button"
                        class="notice-close"
                        aria-label="Dismiss"
                        onClick={() => {
                            dismiss(n.id);
                        }}
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}
