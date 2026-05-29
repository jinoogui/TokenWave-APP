import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';

// Map a filename to a CodeMirror language extension. Unknown types get no
// language support (plain text), which is fine — the editor still works.
function languageFor(/** @type {string} */ filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    switch (ext) {
        case 'js':
        case 'mjs':
        case 'cjs':
        case 'jsx':
            return javascript({ jsx: true });
        case 'ts':
        case 'tsx':
            return javascript({ jsx: true, typescript: true });
        case 'json':
            return json();
        case 'css':
            return css();
        case 'html':
        case 'htm':
            return html();
        case 'md':
        case 'markdown':
            return markdown();
        case 'py':
            return python();
        default:
            return null;
    }
}

/**
 * Mount a CodeMirror editor into `parent`.
 * @param {HTMLElement} parent
 * @param {string} filename — used for language detection
 * @param {string} content — initial document text
 * @param {() => void} onChange — fired on every user edit (for dirty tracking)
 * @param {() => void} onSave — fired on Ctrl/Cmd+S
 * @returns {EditorView}
 */
export function createEditor(parent, filename, content, onChange, onSave) {
    const lang = languageFor(filename);
    const extensions = [
        basicSetup,
        oneDark,
        keymap.of([
            {
                key: 'Mod-s',
                preventDefault: true,
                run: () => { onSave(); return true; },
            },
        ]),
        EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange();
        }),
        EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'JetBrains Mono, Consolas, monospace' },
        }),
    ];
    if (lang) extensions.push(lang);

    return new EditorView({
        state: EditorState.create({ doc: content, extensions }),
        parent,
    });
}
