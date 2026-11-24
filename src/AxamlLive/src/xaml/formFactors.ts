/** Device presets for the previewer (logical pixels, portrait orientation for mobile devices). */
export interface FormFactor {
    id: string;
    label: string;
    width?: number;
    height?: number;
}

export const formFactors: FormFactor[] = [
    { id: "default", label: "Design size" },
    { id: "desktop", label: "Desktop", width: 1920, height: 1080 },
    { id: "phone", label: "Phone", width: 390, height: 844 },
    { id: "tablet", label: "Tablet", width: 768, height: 1024 },
    // a size typed in the toolbar or dragged with the frame's handles
    { id: "custom", label: "Custom" },
];

/** The menu label: the name and the size, so it is clear what each entry shows (design size: filled in by the preview). */
export function formFactorLabel(ff: FormFactor): string {
    return ff.width && ff.height ? `${ff.label} (${ff.width}×${ff.height})` : ff.label;
}

export interface Size {
    width: number;
    height: number;
}

/** Limits of a custom size, in logical pixels. */
export const customSizeLimits = { min: 16, max: 8000 };

/** A custom size within the limits, in whole pixels; undefined when it is not a size at all. */
export function clampCustomSize(width: unknown, height: unknown): Size | undefined {
    // an empty field is no size (Number("") would be 0)
    const number = (v: unknown) => (v === "" || v === null || v === undefined ? NaN : Number(v));
    const w = number(width);
    const h = number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
        return undefined;
    }
    const clamp = (v: number) => Math.round(Math.min(customSizeLimits.max, Math.max(customSizeLimits.min, v)));
    return { width: clamp(w), height: clamp(h) };
}

/**
 * Size of a form factor, optionally rotated. Undefined for "default" (use the XAML's design size), and for "custom"
 * without a custom size. A custom size is never rotated: it is exactly what was typed or dragged.
 */
export function resolveFormFactor(id: string, rotated: boolean, custom?: Size): Size | undefined {
    if (id === "custom") {
        return custom;
    }
    const ff = formFactors.find((f) => f.id === id);
    if (!ff?.width || !ff.height) {
        return undefined;
    }
    return rotated ? { width: ff.height, height: ff.width } : { width: ff.width, height: ff.height };
}
