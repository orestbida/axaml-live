#!/bin/bash
# Builds everything the extension package needs (Release): the VS Code extension, the language server and
# the solution parser. Run from the repository root; then package with: cd src/AxamlLive && npx vsce package
set -e

cd ./src/AxamlLive
npm ci
npm run compile
cd ..

rm -rf AxamlLive/avaloniaServer AxamlLive/solutionParserTool

# Language server
dotnet build AvaloniaLSP/AvaloniaLanguageServer/AvaloniaLanguageServer.csproj -c Release /property:GenerateFullPaths=true --output AxamlLive/avaloniaServer

# Solution parser
dotnet build SolutionParser/SolutionParser.csproj -c Release /property:GenerateFullPaths=true --output AxamlLive/solutionParserTool

echo "Build finished."
