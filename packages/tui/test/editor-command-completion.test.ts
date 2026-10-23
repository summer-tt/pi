import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type AutocompleteItem, CombinedAutocompleteProvider, type SlashCommand } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const argumentItems = [{ value: "inspect", label: "Inspect session arguments" }];

function createEditor(getArguments: NonNullable<SlashCommand["getArgumentCompletions"]> = () => argumentItems) {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	const prefixes: string[] = [];
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			[
				{
					name: "super-pi",
					description: "Manage session",
					getArgumentCompletions: (prefix) => {
						prefixes.push(prefix);
						return getArguments(prefix);
					},
				},
			],
			process.cwd(),
		),
	);
	return { editor, prefixes };
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function renderedLines(editor: Editor): string[] {
	return editor.render(80).map(stripVTControlCharacters);
}

async function offerCommand(editor: Editor, text = "/super-"): Promise<void> {
	editor.handleInput(text);
	await flushAutocomplete();
	assert.strictEqual(editor.isShowingAutocomplete(), true);
	assert.ok(renderedLines(editor).some((line) => line.includes("super-pi") && line.includes("Manage session")));
}

function acceptCommand(editor: Editor, method: "Tab" | "click"): void {
	if (method === "Tab") {
		editor.handleInput("\t");
		return;
	}
	const lines = renderedLines(editor);
	const y = lines.findIndex((line) => line.includes("super-pi") && line.includes("Manage session"));
	assert.ok(y >= 0, "the command row must be visible before clicking it");
	assert.strictEqual(
		editor.handleMouse({
			type: "click",
			button: "left",
			x: 3,
			y,
			screenX: 3,
			screenY: y,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		})?.handled,
		true,
	);
}

describe("Editor command name to argument completion", () => {
	for (const method of ["manual space", "Tab", "click"] as const) {
		it(`requests and displays arguments after ${method}`, async () => {
			const { editor, prefixes } = createEditor();
			if (method === "manual space") {
				await offerCommand(editor, "/super-pi");
				editor.handleInput(" ");
			} else {
				await offerCommand(editor);
				assert.deepStrictEqual(prefixes, []);
				acceptCommand(editor, method);
			}
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "/super-pi ");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
			assert.deepStrictEqual(
				{
					prefixes,
					showing: editor.isShowingAutocomplete(),
					visibleArgument: renderedLines(editor).some((line) => line.includes("Inspect session arguments")),
				},
				{ prefixes: [""], showing: true, visibleArgument: true },
			);
		});
	}

	it("submits the accepted command on Enter without requesting arguments", async () => {
		const { editor, prefixes } = createEditor();
		const submissions: string[] = [];
		editor.onSubmit = (text) => submissions.push(text);
		await offerCommand(editor);
		editor.handleInput("\r");
		await flushAutocomplete();
		assert.deepStrictEqual(submissions, ["/super-pi"]);
		assert.deepStrictEqual(prefixes, []);
		assert.strictEqual(editor.getText(), "");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});

	it("does not request more arguments when accepting an argument", async () => {
		const { editor, prefixes } = createEditor();
		await offerCommand(editor, "/super-pi");
		editor.handleInput(" ");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		editor.handleInput("\t");
		await flushAutocomplete();
		assert.strictEqual(editor.getText(), "/super-pi inspect");
		assert.deepStrictEqual(prefixes, [""]);
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});

	for (const change of ["text", "cursor", "provider", "cancel with setText"] as const) {
		it(`does not continue the old command after onChange changes ${change}`, async () => {
			const { editor, prefixes } = createEditor();
			await offerCommand(editor);
			let changes = 0;
			editor.onChange = (text) => {
				changes++;
				editor.onChange = undefined;
				assert.strictEqual(text, "/super-pi ");
				switch (change) {
					case "text":
						editor.setText("replacement");
						break;
					case "cursor":
						editor.handleInput("\x1b[D");
						break;
					case "provider":
						editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], process.cwd()));
						break;
					case "cancel with setText":
						editor.setText(text);
						break;
				}
			};
			acceptCommand(editor, "Tab");
			await flushAutocomplete();
			assert.strictEqual(changes, 1);
			assert.deepStrictEqual(prefixes, []);
			assert.strictEqual(editor.getText(), change === "text" ? "replacement" : "/super-pi ");
			assert.deepStrictEqual(editor.getCursor(), {
				line: 0,
				col: change === "text" ? 11 : change === "cursor" ? 9 : 10,
			});
			assert.strictEqual(editor.isShowingAutocomplete(), false);
			assert.ok(!renderedLines(editor).some((line) => line.includes("Inspect session arguments")));
		});
	}

	for (const action of ["Escape", "changed input"] as const) {
		it(`discards deferred arguments after ${action} during automatic continuation`, async () => {
			let resolveArguments!: (items: AutocompleteItem[]) => void;
			const argumentsReady = new Promise<AutocompleteItem[]>((resolve) => {
				resolveArguments = resolve;
			});
			const { editor, prefixes } = createEditor(() => argumentsReady);
			try {
				await offerCommand(editor);
				acceptCommand(editor, "Tab");
				await flushAutocomplete();
				assert.deepStrictEqual(prefixes, [""], "automatic argument request must start before cancellation");
				if (action === "Escape") {
					editor.handleInput("\x1b");
				} else {
					editor.setText("replacement");
				}
			} finally {
				resolveArguments(argumentItems);
				await flushAutocomplete();
			}
			assert.strictEqual(editor.getText(), action === "Escape" ? "/super-pi " : "replacement");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
			assert.ok(!renderedLines(editor).some((line) => line.includes("Inspect session arguments")));
		});
	}
});
