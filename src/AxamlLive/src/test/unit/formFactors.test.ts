import * as assert from "assert";
import { clampCustomSize, formFactorLabel, formFactors, resolveFormFactor } from "../../xaml/formFactors";

suite("form factors and custom size", () => {
    test("the size menu: design size, desktop, phone, tablet, custom; device entries show their size", () => {
        assert.deepStrictEqual(
            formFactors.map((f) => f.id),
            ["default", "desktop", "phone", "tablet", "custom"]
        );
        assert.deepStrictEqual(formFactors.map(formFactorLabel), [
            "Design size",
            "Desktop (1920×1080)",
            "Phone (390×844)",
            "Tablet (768×1024)",
            "Custom",
        ]);
    });

    test("a custom size is used as it is, never rotated", () => {
        assert.deepStrictEqual(resolveFormFactor("custom", true, { width: 640, height: 360 }), { width: 640, height: 360 });
        assert.strictEqual(resolveFormFactor("custom", false, undefined), undefined);
    });

    test("devices keep their sizes; design size has none", () => {
        assert.deepStrictEqual(resolveFormFactor("phone", false), { width: 390, height: 844 });
        assert.deepStrictEqual(resolveFormFactor("phone", true), { width: 844, height: 390 });
        assert.strictEqual(resolveFormFactor("default", false), undefined);
    });

    test("typed and dragged sizes are whole pixels within the limits", () => {
        assert.deepStrictEqual(clampCustomSize("640.6", 359.4), { width: 641, height: 359 });
        assert.deepStrictEqual(clampCustomSize(2, 99999), { width: 16, height: 8000 });
        assert.strictEqual(clampCustomSize("abc", 100), undefined);
        assert.strictEqual(clampCustomSize(undefined, 100), undefined);
        assert.strictEqual(clampCustomSize("", 100), undefined, "an empty field");
    });
});
