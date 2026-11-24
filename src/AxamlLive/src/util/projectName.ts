/** Empty when the name can be used for a project (a folder, an assembly and a root namespace). */
export function projectNameError(name: string): string | undefined {
    if (!name.trim()) {
        return "Enter a name.";
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) {
        return "Use letters, digits, '_' and '.', starting with a letter (for example MyApp or Company.App).";
    }
    return undefined;
}
