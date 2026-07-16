// @ts-nocheck
import { expect, test } from "./fixtures/electron-fixture";

test.describe("empty home localization", () => {
  test("English mode renders the open-project flow in English", async ({ window, pageErrors }) => {
    const openProject = window.getByTestId("home-open-project");

    await expect(openProject).toBeVisible();
    await expect(openProject).toHaveText("Open Project");
    await openProject.click();
    await expect(window.getByTestId("dir-modal")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
