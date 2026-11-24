#!/bin/bash
# Builds everything the extension package needs (Release): the VS Code extension, the language server and
# the solution parser and the designer helper for the preview's select mode. Run from the repository root; then package with: cd src/AxamlLive && npx vsce package
set -e

cd ./src/AxamlLive
npm ci
npm run compile
cd ..

rm -rf AxamlLive/avaloniaServer AxamlLive/solutionParserTool AxamlLive/designerHook

# Language server
dotnet build AvaloniaLSP/AvaloniaLanguageServer/AvaloniaLanguageServer.csproj -c Release /property:GenerateFullPaths=true --output AxamlLive/avaloniaServer

# Solution parser
dotnet build SolutionParser/SolutionParser.csproj -c Release /property:GenerateFullPaths=true --output AxamlLive/solutionParserTool

# Select mode helper, loaded into the designer process (.NET startup hook)
dotnet build DesignerHook/AxamlLive.DesignerHook.csproj -c Release /property:GenerateFullPaths=true --output AxamlLive/designerHook

echo "Build finished."
