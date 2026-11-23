/**
 * Feature switches of a trimmed/AOT app that break the designer, which loads XAML at runtime (Reflection.Emit,
 * reflection-based serialization), or that hide its error messages (UseSystemResourceKeys shows resource keys like
 * "Xml_MessageWithErrorPosition" instead of messages). Removed from the previewer's shadow copy only.
 * Returns true when something was removed.
 */
export function designTimeConfigProperties(props: Record<string, unknown>): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(props)) {
		const disablesFeature = value === false && /\.(IsSupported|IsDynamicCodeSupported|CanEmitObjectArrayDelegate|IsReflectionEnabledByDefault)$/.test(key);
		const hidesMessages = value === true && key === "System.Resources.UseSystemResourceKeys";
		if (disablesFeature || hidesMessages) {
			delete props[key];
			changed = true;
		}
	}
	return changed;
}
