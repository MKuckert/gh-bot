// github.mjs — thin REST helpers for the bot round, built on Octokit.

export class GitHub {
  /** @param {import("octokit").Octokit} octokit */
  constructor(octokit, { repo = process.env.GH_REPO ?? "MKuckert/env" } = {}) {
    this.octokit = octokit;
    this.repo = repo;
  }

  /** Open issues only (pull requests filtered out). */
  async listOpenIssues() {
    const { owner, name } = this.splitRepo();
    const { data: issues } = await this.octokit.rest.issues.listForRepo({
      owner,
      repo: name,
      state: "open",
      per_page: 100,
    });
    return issues.filter((i) => !i.pull_request);
  }

  /** All comments for one issue, oldest → newest. */
  async getComments(issue) {
    const { owner, name } = this.splitRepo();
    const { data } = await this.octokit.rest.issues.listComments({
      owner,
      repo: name,
      issue_number: issue.number,
      per_page: 100,
    });
    return data;
  }

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
