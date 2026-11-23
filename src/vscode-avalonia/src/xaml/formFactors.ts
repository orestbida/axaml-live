/** Device presets for the previewer (logical pixels, portrait orientation for mobile devices). */
export interface FormFactor {
	id: string;
	label: string;
	width?: number;
	height?: number;
}

export const formFactors: FormFactor[] = [
	{ id: "default", label: "Design size" },
	{ id: "desktop", label: "Desktop", width: 1280, height: 800 },
	{ id: "laptop", label: "Laptop", width: 1366, height: 768 },
	{ id: "phone", label: "Phone", width: 390, height: 844 },
	{ id: "phoneSmall", label: "Phone S", width: 360, height: 640 },
	{ id: "phoneLarge", label: "Phone L", width: 430, height: 932 },
	{ id: "tablet", label: "Tablet", width: 768, height: 1024 },
	{ id: "tabletLarge", label: "Tablet L", width: 1024, height: 1366 },
];

/** Size of a form factor, optionally rotated. Undefined for "default" (use the XAML's design size). */
export function resolveFormFactor(id: string, rotated: boolean): { width: number; height: number } | undefined {
	const ff = formFactors.find((f) => f.id === id);
	if (!ff?.width || !ff.height) {
		return undefined;
	}
	return rotated ? { width: ff.height, height: ff.width } : { width: ff.width, height: ff.height };
}
