import { expect, test } from "@playwright/test";
import { mockApi } from "./mock";

test.describe("signed out", () => {
  test("login hero and public transparency page", async ({ page }) => {
    const calls = await mockApi(page, { signedIn: false });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Làm việc nhanh hơn với VBot" })).toBeVisible();
    await expect(page.locator(".tabs")).toHaveCount(0);
    await page.goto("/#/minh-bach");
    await expect(page.locator(".kpi")).toHaveCount(4);
    await expect(page.locator(".hero")).toHaveCount(0);
    expect(calls.filter(c => c.path === "/api/me")).toHaveLength(0);   // no authenticated call without a token
  });
});

test.describe("chat", () => {
  test("streams an answer with meta pills and keeps model HTML inert", async ({ page }) => {
    await mockApi(page);
    await page.goto("/#/chat");
    await page.getByText("Báo cáo quý 3").click();
    await expect(page.locator(".md table")).toBeVisible();
    await expect(page.getByText("<script>window.__xss=1</script>")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

    await page.getByLabel("Câu hỏi").fill("Xin chào");
    await page.keyboard.press("Enter");
    const last = page.locator(".msg.assistant").last();
    await expect(last.locator("strong")).toHaveText("câu trả lời");
    await expect(last.locator(".pill.money")).toHaveText("$0.0004");
    await expect(last.getByText("TTFT 0.9s")).toBeVisible();
    await expect(last.getByText("ke_hoach.docx")).toBeVisible();
  });

  test("conversation delete needs a second click", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/#/chat");
    const conv = page.locator(".conv").first();
    await conv.hover();
    await conv.getByRole("button", { name: "Xóa hội thoại" }).click();
    await expect(conv.getByRole("button", { name: /Xác nhận/ })).toBeVisible();
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
    await conv.getByRole("button", { name: /Xác nhận/ }).click();
    await expect.poll(() => calls.some(c => c.method === "DELETE")).toBe(true);
  });
});

test.describe("admin", () => {
  test("hidden for plain users, and the API refusal is shown if they go there anyway", async ({ page }) => {
    await mockApi(page, { role: "user" });
    await page.goto("/#/chat");
    await expect(page.locator(".tabs")).toBeVisible();
    await expect(page.locator(".tabs").getByText("Quản trị")).toHaveCount(0);
    await page.goto("/#/admin");
    await expect(page.getByText("Chỉ quản trị viên mới truy cập được trang này.")).toBeVisible();
  });

  test("platform admin manages users, budgets and audit", async ({ page }) => {
    const calls = await mockApi(page, { role: "platform_admin" });
    await page.goto("/#/chat");
    await page.locator(".tabs").getByText("Quản trị").click();
    await expect(page.getByRole("cell", { name: "nv.kt@cty.vn" })).toBeVisible();
    await expect(page.getByText("Chờ kích hoạt")).toBeVisible();

    await page.getByRole("button", { name: "Thêm người dùng" }).click();
    await page.getByPlaceholder("ten@cty.vn").fill("moi@cty.vn");
    await page.getByPlaceholder("ke-toan").fill("ke-toan");
    await page.getByRole("button", { name: "Tạo và gửi thư mời" }).click();
    await expect.poll(() => calls.find(c => c.method === "POST" && c.path === "/api/admin/users")?.body)
      .toEqual({ email: "moi@cty.vn", department: "ke-toan", role: "user" });

    const row = page.getByRole("row", { name: /nv\.kt@cty\.vn/ });
    await row.getByRole("button", { name: "Khoá" }).click();
    await row.getByRole("button", { name: /Xác nhận/ }).click();
    await expect.poll(() => calls.find(c => c.method === "PATCH")?.body).toEqual({ enabled: false });

    await page.getByRole("button", { name: "Phòng ban & ngân sách" }).click();
    await expect(page.locator(".meter.hot")).toHaveCount(1);   // ke-toan used 90 of 100
    await page.getByRole("button", { name: "Nhật ký" }).click();
    await expect(page.getByText("admin.user.update")).toBeVisible();
  });

  test("unit admin has no audit section", async ({ page }) => {
    await mockApi(page, { role: "unit_admin" });
    await page.goto("/#/admin");
    await expect(page.getByRole("button", { name: "Người dùng" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Nhật ký" })).toHaveCount(0);
  });
});

test("mobile layout has no horizontal scroll", async ({ page }) => {
  await mockApi(page, { role: "platform_admin" });
  await page.setViewportSize({ width: 390, height: 800 });
  for (const tab of ["chat", "files", "usage", "admin", "minh-bach"]) {
    await page.goto(`/#/${tab}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `#/${tab} overflows`).toBeLessThanOrEqual(0);
  }
});
