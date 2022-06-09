/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/* eslint-disable no-console */

import fs from 'fs';

import ts from 'typescript';

import {LH_ROOT} from '../root.js';

const outDir = `${LH_ROOT}/lighthouse-core/lib/cdt/generated`;
const files = {
  'node_modules/chrome-devtools-frontend/front_end/core/sdk/SourceMap.ts': 'SourceMap.js',
};

/**
 * @param {string} code
 * @param {string[]} codeFragments
 */
function assertPresence(code, codeFragments) {
  for (const codeFragment of codeFragments) {
    if (!code.includes(codeFragment)) {
      throw new Error(`did not find expected code fragment: ${codeFragment}`);
    }
  }
}

console.log('making modifications ...');

for (const [inFilename, outFilename] of Object.entries(files)) {
  const code = fs.readFileSync(inFilename, 'utf-8');

  /** @type {string[]} */
  const classesToRemove = [
    // Currently empty.
  ];
  const methodsToRemove = [
    // Not needed.
    'load',
    // Not needed.
    'sourceContentProvider',
  ];
  const variablesToRemove = [
    'Common',
    'CompilerSourceMappingContentProvider_js_1',
    'i18n',
    'i18nString',
    'PageResourceLoader_js_1',
    'Platform',
    'str_',
    'TextUtils',
    'UIStrings',
  ];
  // Complicated expressions are hard detect with the TS lib, so instead work with the raw code.
  const rawCodeToReplace = {
    /* Original:

      let url = Common.ParsedURL.ParsedURL.completeURL(this.#baseURL, href) || href;
      const source = sourceMap.sourcesContent && sourceMap.sourcesContent[i];
      if (url === this.#compiledURLInternal && source) {
        url = Common.ParsedURL.ParsedURL.concatenate(url, '? [sm]');
      }
      if (this.#sourceInfos.has(url)) {
        continue;
      }
      this.#sourceInfos.set(url, new TextSourceMap.SourceInfo(source || null, null));
      sourcesList.push(url);
    ----
    If a source file is the same as the compiled url and there is a sourcesContent,
    then `entry.sourceURL` (what is returned from .mappings) will have `? [sm]` appended.
    This is useful in DevTools - to show that a sources panel tab not a real network resource -
    but for us it is not wanted. The sizing function uses `entry.sourceURL` to index the byte
    counts, and is further used in the details to specify a file within a source map.
    */
    [`url = Common.ParsedURL.ParsedURL.concatenate(url, '? [sm]');`]: '',
    // Prevents preprending the file entries with the sourceRoot, which just
    // complicates JSBundle usage.
    'Common.ParsedURL.ParsedURL.isRelativeURL(href)': 'false',
    // Use normal console.warn so we don't need to import CDT's logger.
    'Common.Console.Console.instance().warn': 'console.warn',
    // Similar to the reason for removing `url += Common.UIString('? [sm]')`.
    // The entries in `.mappings` should not have their url property modified.
    'Common.ParsedURL.ParsedURL.completeURL(this.#baseURL, href)': `''`,
    // Replace i18n function with a very simple templating function.
    'i18n.i18n.getLocalizedString.bind(undefined, str_)': (
      /** @param {string} template @param {object} vars */
      function(template, vars) {
        let result = template;
        for (const [key, value] of Object.entries(vars)) {
          result = result.replace(new RegExp('{' + key + '}'), value);
        }
        return result;
      }).toString(),
    // Add some types.
    // eslint-disable-next-line max-len
    'mappings(): SourceMapEntry[] {': '/** @return {Array<{lineNumber: number, columnNumber: number, sourceURL?: string, sourceLineNumber: number, sourceColumnNumber: number, name?: string, lastColumnNumber?: number}>} */\nmappings(): SourceMapEntry[] {',
  };

  // Verify that all the above code is present.
  assertPresence(code, Object.keys(rawCodeToReplace));

  let modifiedCode = code;

  // First pass - do raw string replacements.
  for (const [code, replacement] of Object.entries(rawCodeToReplace)) {
    modifiedCode = modifiedCode.replace(code, replacement);
  }

  const codeTranspiledToCommonJS = ts.transpileModule(modifiedCode, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;

  const sourceFile = ts.createSourceFile('', codeTranspiledToCommonJS,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const simplePrinter = ts.createPrinter({newLine: ts.NewLineKind.LineFeed});

  // Second pass - use tsc to remove all references to certain variables.
  assertPresence(codeTranspiledToCommonJS, [
    ...classesToRemove,
    ...methodsToRemove,
    ...variablesToRemove,
  ]);

  const printer = ts.createPrinter({newLine: ts.NewLineKind.LineFeed}, {
    substituteNode(hint, node) {
      let removeNode = false;

      if (ts.isMethodDeclaration(node) &&
          // Make typescript happy.
          !ts.isComputedPropertyName(node.name) &&
          methodsToRemove.includes(node.name.text)) {
        removeNode = true;
      }

      if (ts.isClassDeclaration(node) && node.name && classesToRemove.includes(node.name.text)) {
        removeNode = true;
      }

      if (ts.isExpressionStatement(node)) {
        const asString = simplePrinter.printNode(ts.EmitHint.Unspecified, node, sourceFile);
        if (classesToRemove.some(className => asString.includes(className))) {
          removeNode = true;
        }
      }

      if (ts.isVariableDeclarationList(node) && node.declarations.length === 1) {
        // @ts-expect-error: is read-only, but whatever.
        node.declarations =
          node.declarations.filter(d => !variablesToRemove.includes(d.name.getText()));
        if (node.declarations.length === 0) removeNode = true;
      }

      if (removeNode) {
        return ts.createNode(ts.SyntaxKind.Unknown);
      }

      return node;
    },
  });

  let sourceFilePrinted = '';
  sourceFile.forEachChild(node => {
    sourceFilePrinted += printer.printNode(ts.EmitHint.Unspecified, node, sourceFile) + '\n';
  });

  const modifiedFile = [
    '// @ts-nocheck\n',
    '// generated by yarn build-cdt-lib\n',
    'const Platform = require(\'../Platform.js\');\n',
    sourceFilePrinted,
    'module.exports = TextSourceMap;',
  ].join('');
  fs.writeFileSync(`${outDir}/${outFilename}`, modifiedFile);
}
