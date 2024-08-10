const vscode = require('vscode');
const { hideDecoration, transparentDecoration, getUrlDecoration, getSvgDecoration } = require('./common-decorations');
const { state } = require('./state');
const {  memoize, nodeToHtml, svgToUri, htmlToSvg, DefaultMap, texToSvg, enableHoverImage } = require('./util');
const { triggerUpdateDecorations, addDecoration, posToRange }  = require('./runner');
const cheerio = require('cheerio');

let config = vscode.workspace.getConfiguration("markless");

function enableLineRevealAsSignature(context) {
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('markdown', {
        provideSignatureHelp: (document, position) => {
            if (!state.activeEditor) return;
            // console.log('Signature Help');
            const cursorPosition = state.activeEditor.selection.active;

            let latexElement = undefined;
            let start = state.activeEditor.document.offsetAt(cursorPosition)+2;
            let end = start-3;
            while (--start > 0) {
                if (state.text[start-1] === '$' && state.text[start] !== ' ') {
                    while (++end < state.text.length) {
                        if (state.text[end] === '$' && state.text[end-1] !== ' ') {
                            if (start < end)
                                latexElement = `![latexPreview](${svgToUri(texToSvg(state.text.slice(start, end)))})`;
                            break;
                        }
                    }
                    break;
                }
            }

            const text = document.lineAt(cursorPosition).text
                .replace(new RegExp(`(?<=^.{${position.character}})`), "█");
            const ms = new vscode.MarkdownString(latexElement);
            ms.isTrusted = true;
            if (!latexElement) {
                ms.appendCodeblock(text, "markdown");
            }
            // console.log("signature", ms);
            return {
                activeParameter: 0,
                activeSignature: 0,
                signatures: [new vscode.SignatureInformation("", ms)],
            };
        }
    }, '\\'));
}

let requestSvg, webviewLoaded;
function registerWebviewViewProvider (context) {
	let resolveWebviewLoaded, resolveSvg;
	webviewLoaded = new Promise(resolve => { resolveWebviewLoaded = resolve; });
	context.subscriptions.push(vscode.window.registerWebviewViewProvider("test.webview", {
		resolveWebviewView: (webviewView) => {
			webviewView.webview.options = { enableScripts: true };
			const mermaidScriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'));
			webviewView.webview.html = `
					<!DOCTYPE html>
					<html lang="en">
						<body>
						<script src="${mermaidScriptUri}"></script>
						<script>
						// console.log("WEBVIEW ENTER");

						const vscode = acquireVsCodeApi();
						window.addEventListener('message', event => {
							const data = event.data;
							mermaid.mermaidAPI.initialize({
								theme: data.darkMode? "dark":"default",
								fontFamily: data.fontFamily,
								startOnLoad: false
							});
							// console.log("init done");
							// console.log("WEBVIEW RECIEVE FROM EXTENSION", event)
							vscode.postMessage(mermaid.mermaidAPI.render('mermaid', data.source));
						});

						</script>
						</body>
						</html>
						`;
			webviewView.webview.onDidReceiveMessage((svgString) => {
				// console.log(svgString);
				resolveSvg(svgString);
			}, null, context.subscriptions);
			requestSvg = x => {
				webviewView.webview.postMessage(x);
				return new Promise(resolve => { resolveSvg = resolve; });
			};
			resolveWebviewLoaded();
		}
	}, { webviewOptions: { retainContextWhenHidden: true } }));
	vscode.commands.executeCommand('workbench.view.extension.markless')
		.then(() => vscode.commands.executeCommand('workbench.view.explorer'));
}


function clearDecorations() {
	if (!state.decorationRanges) return;
	for (let decoration of state.decorationRanges.keys()) {
		state.activeEditor.setDecorations(decoration, []);
	}
}

function toggle() {
	if (state.enabled) {
		clearDecorations();
		state.enabled = false;
	} else {
		state.enabled = true;
		triggerUpdateDecorations();
	}
}

function bootstrap(context) {
    state.enabled = true;
    state.context = context;
	clearDecorations();
    state.decorationRanges = new DefaultMap(() => []);
    state.config = config;
    state.darkMode = vscode.window.activeColorTheme.kind == vscode.ColorThemeKind.Dark;
    state.fontSize = vscode.workspace.getConfiguration("editor").get("fontSize", 14);
    state.fontFamily = vscode.workspace.getConfiguration("editor").get("fontFamily", "Courier New");

    const lineHeight = vscode.workspace.getConfiguration("editor").get("lineHeight", 0);
    // https://github.com/microsoft/vscode/blob/45aafeb326d0d3d56cbc9e2932f87e368dbf652d/src/vs/editor/common/config/fontInfo.ts#L54
    if (lineHeight === 0) {
        state.lineHeight = Math.round(process.platform == "darwin" ? 1.5 : 1.35 * state.fontSize);
    } else if (lineHeight < 8) {
        state.lineHeight = 8;
    }
    state.autoImagePreview = state.config.get('inlineImage.autoPreview');

	// @ts-ignore
	state.types = new Map([
		["headingBlack", ["heading", (() => {
			const getEnlargeDecoration = memoize((size) => vscode.window.createTextEditorDecorationType({
				color: "#000",
				textDecoration: `; font-size: ${size}px; position: relative; top: 0.1em;`,
			}));
			return (start, end, node) => {
				// console.log("Heading node", node);
				addDecoration(getEnlargeDecoration(5 * state.fontSize / (2 + node.depth)), start + node.depth + 1, end);
				addDecoration(hideDecoration, start, start + node.depth + 1);
			};
		})()]],
		["headingWhite", ["heading", (() => {
			const getEnlargeDecoration = memoize((size) => vscode.window.createTextEditorDecorationType({
				color: "#fff",
				textDecoration: `; font-size: ${size}px; position: relative; top: 0.1em;`,
			}));
			return (start, end, node) => {
				// console.log("Heading node", node);
				addDecoration(getEnlargeDecoration(5 * state.fontSize / (2 + node.depth)), start + node.depth + 1, end);
				addDecoration(hideDecoration, start, start + node.depth + 1);
			};
		})()]],
		["quote", ["blockquote", (() => {
			const newDecoration = vscode.window.createTextEditorDecorationType({
				// textDecoration: "none;",
				color: "#000"
			});
			return (start, end) => {
				addDecoration(newDecoration, start, end);
				// const text = state.text.slice(start, end);
				// const regEx = /^ {0,3}>/mg;
				// let match;
				// while ((match = regEx.exec(text))) {
				// 	// console.log("Quote: ", match);
				// 	addDecoration(quoteDecoration, start + match.index + match[0].length - 1, start + match.index + match[0].length);
				// }
			};
		})()]],
		["inlineCode", ["inlineCode", (() => {
			const codeDecoration = vscode.window.createTextEditorDecorationType({
				// outline: "1px dotted"
				border: "rgb(189, 147, 249) 1px solid;",
				// backgroundColor: "rgb(189, 147, 249);",
				color: "white",
			})
			return (start, end) => {
				// addDecoration(codeDecoration, start + 1, end - 1);
				// addDecoration(transparentDecoration, start, start + 1);
				// addDecoration(transparentDecoration, end - 1, end);
			};
		})()]],
		["link", ["image", (start, end, node) => {
			const text = state.text.slice(start, end);
			const match = /!\[(.*)\]\(.+?\)/.exec(text);
			if (!match) return;
			addDecoration(hideDecoration, start, start + 2);
			addDecoration(getUrlDecoration(true), start + match[1].length + 2, end);
			state.imageList.push([posToRange(start, end), node.url, node.alt || " "]);
		}]],
		["list", ["listItem", (() => {
			const getBulletDecoration = memoize((level) => {
				const listBulletColors = [
				 "green",
 				 "#bd93f9",
				 "#ff5555",
				 "#006ab1",
				]
				return vscode.window.createTextEditorDecorationType({
					color: listBulletColors[level % listBulletColors.length],
				});
			});
			return (start, _end, node, listLevel) => {
				const textPosition = node.children.length > 0 ?
					node.children[0].position : node.position
				const textEnd = textPosition.end.offset;
				addDecoration(getBulletDecoration(listLevel), start, textEnd);
			};
		})()]],
	// @ts-ignore
	].filter(e=>state.config.get(e[0])).map(e => e[1]));

	state.activeEditor = vscode.window.activeTextEditor;
	if (state.activeEditor) {
        if (state.activeEditor.document.languageId == "markdown") {
			state.selection = state.activeEditor.selection;
			triggerUpdateDecorations();
        } else {
            state.activeEditor = undefined;
        }
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	if (config.get('mermaid')) {
		registerWebviewViewProvider(context);
	}
	if (config.get("hoverImage")) {
		enableHoverImage(context);
	}
	enableLineRevealAsSignature(context);
    context.subscriptions.push(vscode.commands.registerCommand("markless.toggle", toggle));
	state.imageList = [];
    state.commentController = vscode.comments.createCommentController("inlineImage", "Show images inline");
    context.subscriptions.push(state.commentController);
	bootstrap(context);

	vscode.window.onDidChangeTextEditorVisibleRanges(event => {
		// console.log("onDidChangeTextEditorVisibleRanges");
		if (state.activeEditor && state.activeEditor.document.lineCount > 500 && event.textEditor.document === state.activeEditor.document) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	vscode.window.onDidChangeActiveTextEditor(editor => {
		// console.log("onDidChangeActiveTextEditor");
		if (editor && editor.document.languageId == "markdown") {
			state.activeEditor = editor;
			triggerUpdateDecorations();
		} else {
			state.activeEditor = undefined;
		}
	}, null, context.subscriptions);

	vscode.workspace.onDidChangeTextDocument(event => {
		// console.log("onDidChangeTextDocument");
		if (state.activeEditor && event.document === state.activeEditor.document) {
			if (event.contentChanges.length == 1) {
				state.changeRangeOffset = event.contentChanges[0].rangeOffset;
			}
			triggerUpdateDecorations();
			state.changeRangeOffset = undefined;
		}
	}, null, context.subscriptions);

	vscode.workspace.onDidChangeConfiguration(e => {
		if (['markless', 'workbench.colorTheme', 'editor.fontSize'].some(c=>e.affectsConfiguration(c))) {
			bootstrap();
		}
	}, null, context.subscriptions);

	vscode.window.onDidChangeTextEditorSelection((e) => {
		if (state.activeEditor) {
			state.selection = e.selections[0];
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions)
}

module.exports = {
	activate,
};