# Third-party notices

The MIT license in `LICENSE` applies to CEU's original code. Third-party code
retains its own copyright and license. Preserve these notices when redistributing.

The no-build client contains these vendored libraries and assets:

| Component | Files | License and included text |
| --- | --- | --- |
| [Marked](https://github.com/markedjs/marked) 15.0.12 | `web/vendor/marked.js` | [MIT and upstream notices](docs/licenses/marked-LICENSE.txt) |
| [DOMPurify](https://github.com/cure53/DOMPurify) 3.4.16 | `web/vendor/purify.js` | Dual Apache-2.0 / MPL-2.0; [Apache text](docs/licenses/dompurify-LICENSE.txt), [MPL text](docs/licenses/dompurify-LICENSE-MPL.txt) |
| [Highlight.js](https://github.com/highlightjs/highlight.js) 11.12.0 | `web/vendor/highlight.js` | [BSD-3-Clause](docs/licenses/highlight.js-LICENSE.txt); embedded copyright headers are retained |
| [KaTeX](https://github.com/KaTeX/KaTeX) 0.16.47 | `web/vendor/katex/`, including fonts | [MIT](docs/licenses/katex-LICENSE.txt) |

License texts are copied from upstream distributions. Marked's text comes from
its v15.0.12 source tag; the other texts come from installed packages. The React
client uses npm-managed versions recorded in `web-app/package-lock.json`, which
may differ from the vendored versions above. Keep package license notices with
compiled distributions. Python and Rust dependency licenses are available in
their package distributions; CEU's license does not relicense those dependencies.

External CLIs, vendor SDKs, model weights, APIs and the optional Ubuntu WSL image
are installed separately and remain subject to their own licenses and terms.
