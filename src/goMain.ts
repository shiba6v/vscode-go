/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Modification copyright 2020 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import { getGoConfig } from './config';
import { GoDebugConfigurationProvider } from './goDebugConfiguration';
import * as GoDebugFactory from './goDebugFactory';
import { setGOROOTEnvVar, toolExecutionEnvironment } from './goEnv';
import { installCurrentPackage } from './goInstall';
import { offerToInstallTools, promptForMissingTool, updateGoVarsFromConfig, suggestUpdates } from './goInstallTools';
import { setLogConfig } from './goLogging';
import { GO_MODE } from './goMode';
import {
	getFromGlobalState,
	resetGlobalState,
	resetWorkspaceState,
	setGlobalState,
	setWorkspaceState,
	updateGlobalState
} from './stateUtils';
import { cleanupTempDir, getBinPath, getToolsGopath, isGoPathSet, resolvePath } from './util';
import vscode = require('vscode');
import { ExtensionAPI } from './export';
import extensionAPI from './extensionAPI';
import { GoExtensionContext } from './context';
import * as commands from './commands';

const goCtx: GoExtensionContext = {};

export async function activate(ctx: vscode.ExtensionContext): Promise<ExtensionAPI | undefined> {
	if (process.env['VSCODE_GO_IN_TEST'] === '1') {
		// Make sure this does not run when running in test.
		return;
	}

	setGlobalState(ctx.globalState);
	setWorkspaceState(ctx.workspaceState);
	// setEnvironmentVariableCollection(ctx.environmentVariableCollection);

	const cfg = getGoConfig();
	setLogConfig(cfg['logging']);

	// WelcomePanel.activate(ctx, goCtx);

	const configGOROOT = getGoConfig()['goroot'];
	if (configGOROOT) {
		// We don't support unsetting go.goroot because we don't know whether
		// !configGOROOT case indicates the user wants to unset process.env['GOROOT']
		// or the user wants the extension to use the current process.env['GOROOT'] value.
		// TODO(hyangah): consider utilizing an empty value to indicate unset?
		await setGOROOTEnvVar(configGOROOT);
	}

	await showDeprecationWarning();
	await updateGoVarsFromConfig(goCtx);

	suggestUpdates();
	// offerToInstallLatestGoVersion();
	offerToInstallTools();

	const registerCommand = commands.createRegisterCommand(ctx, goCtx);

	GoDebugConfigurationProvider.activate(ctx, goCtx);
	GoDebugFactory.activate(ctx);

	registerCommand('go.refill.struct', commands.runRefillStruct);
	registerCommand('go.install.package', installCurrentPackage);
	registerCommand('go.workspace.resetState', resetWorkspaceState);
	registerCommand('go.global.resetState', resetGlobalState);
	vscode.languages.setLanguageConfiguration(GO_MODE.language, {
		wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g
	});

	// Vulncheck output link provider.
	// VulncheckOutputLinkProvider.activate(ctx);
	// registerCommand('go.vulncheck.toggle', toggleVulncheckCommandFactory);

	return extensionAPI;
}

export function deactivate() {
	return Promise.all([
		goCtx.languageClient?.stop(),
		// cancelRunningTests(),
		// killRunningPprof(),
		Promise.resolve(cleanupTempDir())
		// Promise.resolve(disposeGoStatusBar())
	]);
}

async function showDeprecationWarning() {
	const cfg = getGoConfig();
	const experimentalFeatures = cfg['languageServerExperimentalFeatures'];
	if (experimentalFeatures) {
		// TODO(golang/vscode-go#50): Eventually notify about deprecation of
		// all of the settings. See golang/vscode-go#1109 too.
		// The `diagnostics` setting is still used as a workaround for running custom vet.
		const promptKey = 'promptedLanguageServerExperimentalFeatureDeprecation';
		const prompted = getFromGlobalState(promptKey, false);
		if (!prompted && experimentalFeatures['diagnostics'] === false) {
			const msg = `The 'go.languageServerExperimentalFeature.diagnostics' setting will be deprecated soon.
	If you would like additional configuration for diagnostics from gopls, please see and response to [Issue 50](https://go.dev/s/vscode-issue/50).`;
			const selected = await vscode.window.showInformationMessage(msg, "Don't show again");
			switch (selected) {
				case "Don't show again":
					updateGlobalState(promptKey, true);
			}
		}
	}
	const codelensFeatures = cfg['enableCodeLens'];
	if (codelensFeatures && codelensFeatures['references']) {
		const promptKey = 'promptedCodeLensReferencesFeatureDeprecation';
		const prompted = getFromGlobalState(promptKey, false);
		if (!prompted) {
			const msg =
				"The 'go.enableCodeLens.references' setting will be removed soon. Please see [Issue 2509](https://go.dev/s/vscode-issue/2509).";
			const selected = await vscode.window.showWarningMessage(msg, 'Update Settings', "Don't show again");
			switch (selected) {
				case 'Update Settings':
					{
						const { globalValue, workspaceValue, workspaceFolderValue } = cfg.inspect<{
							[key: string]: boolean;
						}>('enableCodeLens') || {
							globalValue: undefined,
							workspaceValue: undefined,
							workspaceFolderValue: undefined
						};
						if (globalValue && globalValue['references']) {
							delete globalValue.references;
							cfg.update('enableCodeLens', globalValue, vscode.ConfigurationTarget.Global);
						}
						if (workspaceValue && workspaceValue['references']) {
							delete workspaceValue.references;
							cfg.update('enableCodeLens', workspaceValue, vscode.ConfigurationTarget.Workspace);
						}
						if (workspaceFolderValue && workspaceFolderValue['references']) {
							delete workspaceFolderValue.references;
							cfg.update(
								'enableCodeLens',
								workspaceFolderValue,
								vscode.ConfigurationTarget.WorkspaceFolder
							);
						}
					}
					break;
				case "Don't show again":
					updateGlobalState(promptKey, true);
					break;
			}
		}
	}
}
