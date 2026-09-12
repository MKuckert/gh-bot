// github.mjs — thin REST helpers for the bot round, built on Octokit.

/** True for GitHub App / integration logins (e.g. "overcommit-bot[bot]"). */
export function isBotLogin(login) {
  return typeof login === "string" && login.endsWith("[bot]");
}

export class GitHub {
  /** @param {import("octokit").Octokit} octokit */
  constructor(octokit, { repo = process.env.GH_REPO ?? "MKuckert/env", botLogin = process.env.BOT_LOGIN ?? "overcommit-app[bot]" } = {}) {
    this.octokit = octokit;
    this.repo = repo;
    this.botLogin = botLogin; // the app's real login — used to find our own comments
  }

  /** Open issues only (pull requests filtered out), paginated. */
  async listOpenIssues() {
    const { owner, name } = this.splitRepo();
    const issues = [];
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.rest.issues.listForRepo({
        owner,
        repo: name,
        state: "open",
        per_page: 100,
        page,
      });
      issues.push(...data);
      if (data.length < 100) break;
    }
    return issues.filter((i) => !i.pull_request);
  }

  /** All comments for one issue (or PR — same API), paginated, oldest → newest. */
  async getComments(issue) {
    const { owner, name } = this.splitRepo();
    const out = [];
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.rest.issues.listComments({
        owner,
        repo: name,
        issue_number: issue.number,
        per_page: 100,
        page,
      });
      out.push(...data);
      if (data.length < 100) return out;
    }
  }

  /**
   * PRs linked to an issue via cross-references (a body mention of the issue or
   * a Development-section link both produce `cross-referenced` timeline events).
   * Only open and merged PRs are returned; closed-unmerged ones are dead ends.
   */
  async getLinkedPullRequests(issue) {
    const { owner, name } = this.splitRepo();
    const byNumber = new Map();
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.rest.issues.listTimeline({
        owner,
        repo: name,
        issue_number: issue.number,
        per_page: 100,
        page,
      });
      for (const ev of data) {
        const src = ev.source?.issue;
        if (ev.event !== "cross-referenced" || !src?.pull_request) continue;
        // cross-references include PRs from OTHER repos that merely mention the
        // issue — their numbers are meaningless here (and dangerous to clone).
        if (src.repository?.full_name !== this.repo) continue;
        byNumber.set(src.number, src);
      }
      if (data.length < 100) break;
    }
    return [...byNumber.values()]
      // the issues API reports merged PRs as state "closed" + pull_request.merged_at
      .filter((pr) => pr.state === "open" || pr.pull_request.merged_at)
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        body: pr.body ?? "",
        headRef: pr.head?.ref,
        headSha: pr.head?.sha,
        baseRef: pr.base?.ref,
      }));
  }

  /** Our own newest comment on an issue/PR (null if none) — re-review feedback. */
  async getLastBotComment(prNumber) {
    const comments = await this.getComments({ number: prNumber });
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].user?.login === this.botLogin) return comments[i];
    }
    return null;
  }

  /** Post a comment on an issue or PR (PRs accept issue comments). */
  async postComment(issue, body) {
    const { owner, name } = this.splitRepo();
    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo: name,
      issue_number: issue.number,
      body,
    });
    return data;
  }

  /** `owner/name` → { owner, name }; the env var is documented as `GH_REPO`. */
  splitRepo() {
    const [owner, ...rest] = this.repo.split("/");
    if (!owner || rest.length === 0) {
      throw new Error(`GitHub: GH_REPO must be "owner/name", got "${this.repo}"`);
    }
    return { owner, name: rest.join("/") };
  }
}
