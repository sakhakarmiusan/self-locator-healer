import { test, expect } from '@playwright/test';
import { smartClick, smartFill } from '../healing/smartActions';

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login.html');
  });

  test.only('valid login goes to the dashboard', async ({ page }) => {
    await smartFill(page, 'usernameInput', '#username', 'admin');
    await smartFill(page, 'passwordInput', '#password', '1234');
    await smartClick(page, 'loginButton', '#login-btn');

    await expect(page).toHaveURL(/\/dashboard\.html$/);
    await expect(page.getByText('Welcome, admin')).toBeVisible();
  });

  test('invalid login shows an error message', async ({ page }) => {
    await smartFill(page, 'usernameInput', '#username', 'admin');
    await smartFill(page, 'passwordInput', '#password', 'wrong-password');
    await smartClick(page, 'loginButton', '#login-btn');

    await expect(page.getByText('Invalid username or password')).toBeVisible();
  });
});
