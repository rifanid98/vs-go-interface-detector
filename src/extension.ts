import * as path from 'path';
import * as vscode from 'vscode';

// ── Types ────────────────────────────────────────────────────────────────

interface InterfaceMethod {
    line: number;
    name: string;
    nameIdx: number;
    interfaceName: string;
}

interface StructMethod {
    line: number;
    name: string;
    nameIdx: number;
    receiverType: string;
}

// ── State ────────────────────────────────────────────────────────────────

let interfaceDecorationType: vscode.TextEditorDecorationType;
let implDecorationType: vscode.TextEditorDecorationType;
let outputChannel: vscode.OutputChannel;

// ── Activation ───────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel("Go Interface Detector");
    outputChannel.appendLine("Extension activated.");
    const iconPath = vscode.Uri.file(
        context.asAbsolutePath(path.join('images', 'implemented.svg'))
    );

    interfaceDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: iconPath,
        gutterIconSize: '85%',
    });

    implDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: iconPath,
        gutterIconSize: '85%',
    });

    // Register navigation commands
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'go-interface-detector.goToImplementation',
            goToImplementationHandler
        ),
        vscode.commands.registerCommand(
            'go-interface-detector.goToInterface',
            goToInterfaceHandler
        )
    );

    const codeLensProvider = new GoInterfaceCodeLensProvider();

    // Register CodeLens provider
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'go', scheme: 'file' },
            codeLensProvider
        )
    );

    // Debounced decoration updates
    let timeout: NodeJS.Timeout | undefined;
    let goplsStartRetryCount = 0;

    function triggerUpdateDecorations(editor: vscode.TextEditor | undefined) {
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        if (editor?.document.languageId === 'go') {
            timeout = setTimeout(() => {
                void updateDecorations(editor).then((success) => {
                    if (success) {
                        codeLensProvider.refresh();
                        goplsStartRetryCount = 0;
                    } else if (goplsStartRetryCount < 10) {
                        // gopls likely not ready, retry up to 10 times (10 seconds)
                        goplsStartRetryCount++;
                        setTimeout(() => triggerUpdateDecorations(editor), 1000);
                    }
                });
            }, 300);
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            triggerUpdateDecorations(editor);
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                triggerUpdateDecorations(editor);
            }
        })
    );

    if (vscode.window.activeTextEditor) {
        triggerUpdateDecorations(vscode.window.activeTextEditor);
    }
}

// ── CodeLens Provider ────────────────────────────────────────────────────

class GoInterfaceCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        if (document.languageId !== 'go') {
            return [];
        }

        const lenses: vscode.CodeLens[] = [];

        // ── Interface method side: show "N implementation(s)" ──
        const interfaceMethods = findInterfaceMethods(document);
        outputChannel.appendLine(`[CodeLens] found ${interfaceMethods.length} interface methods in ${document.uri.fsPath}`);
        
        for (const method of interfaceMethods) {
            const position = new vscode.Position(method.line, method.nameIdx);
            try {
                const implementations = await vscode.commands.executeCommand<
                    vscode.Location[] | vscode.LocationLink[]
                >('vscode.executeImplementationProvider', document.uri, position);

                if (implementations && implementations.length > 0) {
                    const range = new vscode.Range(method.line, 0, method.line, 0);
                    lenses.push(
                        new vscode.CodeLens(range, {
                            title: `$(arrow-down) ${implementations.length} implementation(s)`,
                            command: 'go-interface-detector.goToImplementation',
                            arguments: [document.uri, position],
                        })
                    );
                    outputChannel.appendLine(`[CodeLens] Interface ${method.name}: ${implementations.length} implementations`);
                } else {
                    outputChannel.appendLine(`[CodeLens] Interface ${method.name}: No implementations found`);
                }
            } catch (err: any) {
                outputChannel.appendLine(`[CodeLens] Error executing provider for ${method.name}: ${err?.message || err}`);
            }
        }

        // ── Struct method side: show "implements InterfaceName" ──
        const structMethods = findStructMethods(document);
        outputChannel.appendLine(`[CodeLens] found ${structMethods.length} struct methods in ${document.uri.fsPath}`);
        
        for (const method of structMethods) {
            const position = new vscode.Position(method.line, method.nameIdx);
            try {
                const results = await vscode.commands.executeCommand<
                    vscode.Location[] | vscode.LocationLink[]
                >('vscode.executeImplementationProvider', document.uri, position);

                if (results && results.length > 0) {
                    // Filter out self-references (same file + same line)
                    const filtered = results
                        .map(toLocation)
                        .filter(
                            (loc) =>
                                loc.uri.fsPath !== document.uri.fsPath ||
                                loc.range.start.line !== method.line
                        );

                    if (filtered.length > 0) {
                        const interfaceInfo = await resolveInterfaceName(
                            filtered,
                            method.name
                        );

                        if (interfaceInfo) {
                            const range = new vscode.Range(method.line, 0, method.line, 0);
                            lenses.push(
                                new vscode.CodeLens(range, {
                                    title: `$(arrow-up) implements ${interfaceInfo}`,
                                    command: 'go-interface-detector.goToInterface',
                                    arguments: [document.uri, position],
                                })
                            );
                        }
                    }
                }
            } catch {
                // gopls may not be ready
            }
        }

        return lenses;
    }
}

// ── Navigation Handlers ──────────────────────────────────────────────────

async function goToImplementationHandler(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<void> {
    try {
        const implementations = await vscode.commands.executeCommand<
            vscode.Location[] | vscode.LocationLink[]
        >('vscode.executeImplementationProvider', uri, position);

        if (!implementations || implementations.length === 0) {
            vscode.window.showInformationMessage('No implementations found.');
            return;
        }

        const locations = implementations.map(toLocation);

        if (locations.length === 1) {
            await navigateToLocation(locations[0]);
        } else {
            const config = vscode.workspace.getConfiguration('goInterfaceDetector');
            const behavior = config.get<string>('navigationBehavior', 'peek');

            if (behavior === 'quickPick') {
                const items = locations.map(loc => {
                    const filename = path.basename(loc.uri.fsPath);
                    const line = loc.range.start.line + 1;
                    return {
                        label: `$(symbol-method) ${filename}:${line}`,
                        description: loc.uri.fsPath,
                        location: loc
                    };
                });

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select an implementation to navigate to',
                    matchOnDescription: true
                });

                if (selected) {
                    await navigateToLocation(selected.location);
                }
            } else {
                // Show the built-in peek panel (same as "Go to Implementations")
                await vscode.commands.executeCommand(
                    'editor.action.showReferences',
                    uri,
                    position,
                    locations
                );
            }
        }
    } catch (error) {
        console.error('goToImplementation error:', error);
    }
}

async function goToInterfaceHandler(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<void> {
    try {
        const results = await vscode.commands.executeCommand<
            vscode.Location[] | vscode.LocationLink[]
        >('vscode.executeImplementationProvider', uri, position);

        if (!results || results.length === 0) {
            vscode.window.showInformationMessage('No interface definition found.');
            return;
        }

        // Filter out self-references
        const filtered = results
            .map(toLocation)
            .filter(
                (loc) =>
                    loc.uri.fsPath !== uri.fsPath ||
                    loc.range.start.line !== position.line
            );

        if (filtered.length === 0) {
            vscode.window.showInformationMessage('No interface definition found.');
            return;
        }

        if (filtered.length === 1) {
            await navigateToLocation(filtered[0]);
        } else {
            const config = vscode.workspace.getConfiguration('goInterfaceDetector');
            const behavior = config.get<string>('navigationBehavior', 'peek');

            if (behavior === 'quickPick') {
                const items = filtered.map(loc => {
                    const filename = path.basename(loc.uri.fsPath);
                    const line = loc.range.start.line + 1;
                    return {
                        label: `$(symbol-interface) ${filename}:${line}`,
                        description: loc.uri.fsPath,
                        location: loc
                    };
                });

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select an interface definition to navigate to',
                    matchOnDescription: true
                });

                if (selected) {
                    await navigateToLocation(selected.location);
                }
            } else {
                // Show the built-in peek panel (same as "Go to Implementations")
                await vscode.commands.executeCommand(
                    'editor.action.showReferences',
                    uri,
                    position,
                    filtered
                );
            }
        }
    } catch (error) {
        console.error('goToInterface error:', error);
    }
}

// ── Parsing: Interface Methods ───────────────────────────────────────────

function findInterfaceMethods(document: vscode.TextDocument): InterfaceMethod[] {
    const lines = document.getText().split(/\r?\n/);
    const methods: InterfaceMethod[] = [];

    let inInterface = false;
    let braceDepth = 0;
    let currentInterfaceName = '';

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];

        if (!inInterface) {
            const interfaceMatch = /^[\t ]*type\s+([A-Za-z0-9_]+)\s+interface\b/.exec(line);
            if (!interfaceMatch) {
                continue;
            }

            currentInterfaceName = interfaceMatch[1];
            braceDepth =
                (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            inInterface = braceDepth > 0;
            continue;
        }

        // Inside interface body — look for method signatures
        const method = extractMethodFromLine(line);
        if (method) {
            methods.push({
                line: lineNumber,
                name: method.name,
                nameIdx: method.nameIdx,
                interfaceName: currentInterfaceName,
            });
        }

        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;

        if (braceDepth <= 0) {
            inInterface = false;
            currentInterfaceName = '';
        }
    }

    return methods;
}

// ── Parsing: Struct (Receiver) Methods ───────────────────────────────────

function findStructMethods(document: vscode.TextDocument): StructMethod[] {
    const lines = document.getText().split(/\r?\n/);
    const methods: StructMethod[] = [];

    // Match: func (r *Type) MethodName(...)
    // or:    func (r Type) MethodName(...)
    const receiverMethodRegex =
        /^[\t ]*func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+([A-Za-z_]\w*)\s*\(/;

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const match = receiverMethodRegex.exec(lines[lineNumber]);
        if (!match) {
            continue;
        }

        const receiverType = match[1];
        const methodName = match[2];
        const nameIdx = lines[lineNumber].indexOf(methodName, match.index + match[0].indexOf(methodName));

        methods.push({
            line: lineNumber,
            name: methodName,
            nameIdx: nameIdx >= 0 ? nameIdx : 0,
            receiverType,
        });
    }

    return methods;
}

// ── Parsing Helper ───────────────────────────────────────────────────────

function extractMethodFromLine(
    line: string,
    startIndex = 0
): { name: string; nameIdx: number } | undefined {
    const candidate = line.slice(startIndex);
    const match = /^[\t ]*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(candidate);
    if (!match) {
        return undefined;
    }

    const name = match[1];
    const nameIdx = line.indexOf(name, startIndex);
    if (nameIdx === -1) {
        return undefined;
    }

    return { name, nameIdx };
}

// ── Gutter Decoration Update ─────────────────────────────────────────────

async function updateDecorations(editor: vscode.TextEditor): Promise<boolean> {
    if (editor.document.languageId !== 'go') {
        return true;
    }

    const interfaceDecorations: vscode.DecorationOptions[] = [];
    const implDecorations: vscode.DecorationOptions[] = [];
    
    const interfaceMethods = findInterfaceMethods(editor.document);
    const structMethods = findStructMethods(editor.document);
    
    outputChannel.appendLine(`[Decorations] updating for ${editor.document.uri.fsPath}. Interface methods: ${interfaceMethods.length}, Struct methods: ${structMethods.length}`);
    
    if (interfaceMethods.length === 0 && structMethods.length === 0) {
        editor.setDecorations(interfaceDecorationType, interfaceDecorations);
        editor.setDecorations(implDecorationType, implDecorations);
        return true;
    }

    let providerSuccess = false;

    // ── Interface methods: check for implementations ──
    for (const method of interfaceMethods) {
        const position = new vscode.Position(method.line, method.nameIdx);
        try {
            const implementations = await vscode.commands.executeCommand<
                vscode.Location[] | vscode.LocationLink[]
            >('vscode.executeImplementationProvider', editor.document.uri, position);

            providerSuccess = true;
            if (implementations && implementations.length > 0) {
                interfaceDecorations.push({
                    range: new vscode.Range(method.line, 0, method.line, 0),
                    hoverMessage: new vscode.MarkdownString(
                        `**${method.name}()** — ${implementations.length} implementation(s)`
                    ),
                });
            }
        } catch (err: any) {
            outputChannel.appendLine(`[Decorations] Error executing provider for interface ${method.name}: ${err?.message || err}`);
        }
    }

    // ── Struct methods: check if they implement an interface ──
    for (const method of structMethods) {
        const position = new vscode.Position(method.line, method.nameIdx);
        try {
            const results = await vscode.commands.executeCommand<
                vscode.Location[] | vscode.LocationLink[]
            >('vscode.executeImplementationProvider', editor.document.uri, position);

            providerSuccess = true;
            if (results && results.length > 0) {
                // Filter out self-references
                const filtered = results
                    .map(toLocation)
                    .filter(
                        (loc) =>
                            loc.uri.fsPath !== editor.document.uri.fsPath ||
                            loc.range.start.line !== method.line
                    );

                if (filtered.length > 0) {
                    const interfaceName = await resolveInterfaceName(
                        filtered,
                        method.name
                    );

                    if (interfaceName) {
                        implDecorations.push({
                            range: new vscode.Range(method.line, 0, method.line, 0),
                            hoverMessage: new vscode.MarkdownString(
                                `**${method.name}()** implements *${interfaceName}*`
                            ),
                        });
                    }
                }
            }
        } catch (err: any) {
            outputChannel.appendLine(`[Decorations] Error executing provider for struct ${method.name}: ${err?.message || err}`);
        }
    }

    editor.setDecorations(interfaceDecorationType, interfaceDecorations);
    editor.setDecorations(implDecorationType, implDecorations);
    
    return providerSuccess;
}

// ── Utilities ────────────────────────────────────────────────────────────

function toLocation(item: vscode.Location | vscode.LocationLink): vscode.Location {
    if ('targetUri' in item) {
        return new vscode.Location(item.targetUri, item.targetRange);
    }
    return item;
}

async function navigateToLocation(location: vscode.Location): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(location.uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(
        location.range.start,
        location.range.start
    );
    editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
}

async function resolveInterfaceName(
    typeDefinitions: (vscode.Location | vscode.LocationLink)[],
    _methodName: string
): Promise<string | null> {
    for (const def of typeDefinitions) {
        const loc = toLocation(def);
        try {
            const doc = await vscode.workspace.openTextDocument(loc.uri);
            const line = doc.lineAt(loc.range.start.line).text;

            // Check if line declares an interface
            const match = /type\s+(\w+)\s+interface\b/.exec(line);
            if (match) {
                return match[1];
            }

            // The type definition might point inside the interface body;
            // scan upward to find the interface declaration
            for (
                let i = loc.range.start.line - 1;
                i >= 0 && i >= loc.range.start.line - 50;
                i--
            ) {
                const prevLine = doc.lineAt(i).text;
                const parentMatch = /type\s+(\w+)\s+interface\b/.exec(prevLine);
                if (parentMatch) {
                    return parentMatch[1];
                }
                // Stop if we hit another type declaration
                if (/^[\t ]*type\s+/.test(prevLine) && !prevLine.includes('interface')) {
                    break;
                }
            }
        } catch {
            // File may not be accessible
        }
    }
    return null;
}

// ── Deactivation ─────────────────────────────────────────────────────────

export function deactivate() {
    if (interfaceDecorationType) {
        interfaceDecorationType.dispose();
    }
    if (implDecorationType) {
        implDecorationType.dispose();
    }
}