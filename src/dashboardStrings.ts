import * as vscode from 'vscode';

/**
 * Every label used by the dashboard webview, keyed by a stable id.
 * Placeholders ({0}, {1}) are filled in by the webview.
 * Calls stay literal so `@vscode/l10n-dev export` can extract them.
 */
export function dashboardStrings(): Record<string, string> {
  return {
    // Header / footer
    title: vscode.l10n.t('Copilot Contingent'),
    updated: vscode.l10n.t('Updated {0}'),
    justNow: vscode.l10n.t('just now'),
    offline: vscode.l10n.t('Offline'),
    offlineHint: vscode.l10n.t('The last refresh failed. Showing cached data.'),
    refresh: vscode.l10n.t('Refresh'),

    // Hero
    leftOf: vscode.l10n.t('left of {0} {1}'),
    usedThisCycle: vscode.l10n.t('{0} {1} used this cycle'),
    unlimited: vscode.l10n.t('Unlimited'),
    unlimitedHint: vscode.l10n.t('Your plan has no limit here. Use Copilot freely.'),
    resets: vscode.l10n.t('Resets {0}'),
    gaugeLabel: vscode.l10n.t('{0} of {1} {2} left ({3}% used)'),
    planMarker: vscode.l10n.t('Plan: about {0} should be left today'),
    monthElapsed: vscode.l10n.t('Month elapsed'),
    allowanceUsed: vscode.l10n.t('Allowance used'),
    plan: vscode.l10n.t('Plan'),

    // Tiles
    today: vscode.l10n.t('Today'),
    ofBudget: vscode.l10n.t('of {0} budget'),
    dailyBudget: vscode.l10n.t('Daily budget'),
    budgetDaysLeft: vscode.l10n.t('{0} budget days left'),
    pace: vscode.l10n.t('Pace'),
    perDay: vscode.l10n.t('{0}/day'),
    planPerDay: vscode.l10n.t('plan {0}/day'),
    buffer: vscode.l10n.t('Buffer'),
    aheadOfPlan: vscode.l10n.t('ahead of plan · {0} days'),
    overPlan: vscode.l10n.t('over plan · {0} days'),
    atReset: vscode.l10n.t('At reset'),
    projectedOf: vscode.l10n.t('projected of {0}'),
    emptyOn: vscode.l10n.t('empty on {0}'),
    streak: vscode.l10n.t('Streak'),
    streakOne: vscode.l10n.t('1 day'),
    streakMany: vscode.l10n.t('{0} days'),
    withinBudget: vscode.l10n.t('within budget'),
    last7: vscode.l10n.t('Last 7 days'),
    avgPerDay: vscode.l10n.t('Ø {0}/day'),
    cycleAverage: vscode.l10n.t('Cycle average'),
    perBudgetDay: vscode.l10n.t('per budget day'),

    // Chart
    dailyUsage: vscode.l10n.t('Daily usage'),
    chartLabel: vscode.l10n.t('Daily usage this cycle, plan {0} per day'),
    legendPlan: vscode.l10n.t('Plan per day'),
    legendToday: vscode.l10n.t('Today'),
    legendWeekend: vscode.l10n.t('Weekend'),
    legendEstimated: vscode.l10n.t('Estimated'),
    estimatedNote: vscode.l10n.t('estimated (before tracking started)'),
    weekendNote: vscode.l10n.t('weekend'),

    // Overage
    overage: vscode.l10n.t('Overage'),
    overageEnabled: vscode.l10n.t('Requests beyond your allowance are billed. Set a spending limit to stay in control.'),
    overageCount: vscode.l10n.t('Overage this month: {0}'),
    openBilling: vscode.l10n.t('Open GitHub billing'),

    // Tips
    tips: vscode.l10n.t('Saving tips'),
    relevantNow: vscode.l10n.t('relevant now'),
    prevTip: vscode.l10n.t('Previous tip'),
    nextTip: vscode.l10n.t('Next tip'),
    tipCounter: vscode.l10n.t('{0} of {1}'),
    allTips: vscode.l10n.t('All tips'),
    openGuide: vscode.l10n.t('Open guide'),

    // Quick settings
    quickSettings: vscode.l10n.t('Quick settings'),
    statusBarShows: vscode.l10n.t('Status bar shows'),
    displayRemaining: vscode.l10n.t('Remaining'),
    displayUsed: vscode.l10n.t('Used'),
    displayPercent: vscode.l10n.t('Percent'),
    displayDailyBudget: vscode.l10n.t('Per day'),
    budgetGroup: vscode.l10n.t('Budget'),
    countWeekends: vscode.l10n.t('Count weekends'),
    countWeekendsHint: vscode.l10n.t('Spread the budget over all days, not only workdays'),
    reserve: vscode.l10n.t('Reserve'),
    reserveHint: vscode.l10n.t('Kept aside and excluded from the daily budget'),
    warningsGroup: vscode.l10n.t('Warnings'),
    warnings: vscode.l10n.t('Threshold warnings'),
    thresholds: vscode.l10n.t('Warn at'),
    addThreshold: vscode.l10n.t('Add threshold'),
    removeThreshold: vscode.l10n.t('Remove {0}%'),
    paceWarning: vscode.l10n.t('Pace warning'),
    paceWarningHint: vscode.l10n.t('Warn when you are on course to run out before reset'),
    snooze: vscode.l10n.t('Snooze 24h'),
    snoozedUntil: vscode.l10n.t('Snoozed until {0}'),
    unsnooze: vscode.l10n.t('Resume'),
    showTips: vscode.l10n.t('Show tips'),
    signInProvider: vscode.l10n.t('Sign-in provider'),
    providerAuto: vscode.l10n.t('Auto'),
    providerGitHub: vscode.l10n.t('GitHub'),
    providerEnterprise: vscode.l10n.t('Enterprise'),
    copilotGroup: vscode.l10n.t('Copilot'),
    copilotCompletions: vscode.l10n.t('Inline completions'),
    copilotNextEdit: vscode.l10n.t('Next edit suggestions'),
    freeHint: vscode.l10n.t('Do not use your allowance'),
    manageCopilot: vscode.l10n.t('Manage Copilot'),
    openChat: vscode.l10n.t('Open chat'),
    allSettings: vscode.l10n.t('All settings'),
    showLog: vscode.l10n.t('Show log'),

    // States
    loading: vscode.l10n.t('Loading Copilot quota…'),
    signedOutTitle: vscode.l10n.t('Sign in to see your Copilot quota'),
    signedOutText: vscode.l10n.t('Copilot Contingent reads your allowance from GitHub and helps you make it last until the end of the month.'),
    signIn: vscode.l10n.t('Sign in with GitHub'),
    signInEnterprise: vscode.l10n.t('Sign in with GitHub Enterprise'),
    enterpriseHint: vscode.l10n.t('Enterprise account? Set the provider in the settings or check the log.'),
    noCopilotTitle: vscode.l10n.t('No metered Copilot quota found for this account'),
    noCopilotText: vscode.l10n.t('This account has no Copilot allowance with a monthly limit, or the quota cannot be read. Try another sign-in provider or check the log.'),
    errorTitle: vscode.l10n.t('Could not load Copilot quota'),
    retry: vscode.l10n.t('Retry'),
  };
}
