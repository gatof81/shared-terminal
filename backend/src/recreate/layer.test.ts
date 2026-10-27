import { describe, expect, it } from "vitest";
import {
	classifyLayer,
	ENTRYPOINT_SYMLINKS,
	type LayerChange,
	type LayerInput,
	type PathStat,
	parseGitconfig,
} from "./layer.js";

const H = "/home/developer";
const ID = { name: "Ada Lovelace", email: "ada@example.com" };
const GOOD_GITCONFIG = Buffer.from("[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n");

/** What a clean boot of the session image leaves in the layer, with its true shapes. */
function cleanBoot(): { changes: LayerChange[]; stats: Map<string, PathStat> } {
	const stats = new Map<string, PathStat>();
	for (const [link, target] of ENTRYPOINT_SYMLINKS)
		stats.set(link, { kind: "symlink", linkTarget: target });
	stats.set(`${H}/.config`, { kind: "dir" });
	stats.set("/tmp/.st-ready", { kind: "file" });
	stats.set("/tmp/tmux-1000", { kind: "dir" });
	stats.set("/tmp/tmux-1000/default", { kind: "socket" });
	for (const d of ["/home", H, "/tmp"]) stats.set(d, { kind: "dir" });
	stats.set(`${H}/uploads`, { kind: "dir" });
	const changes: LayerChange[] = [
		{ Path: "/home", Kind: 0 },
		{ Path: H, Kind: 0 },
		{ Path: `${H}/.npm-global`, Kind: 0 },
		{ Path: `${H}/.vscode-cli`, Kind: 1 },
		{ Path: `${H}/.config`, Kind: 1 },
		{ Path: `${H}/.config/gh`, Kind: 1 },
		{ Path: `${H}/.claude`, Kind: 1 },
		{ Path: `${H}/.claude.json`, Kind: 1 },
		{ Path: `${H}/.ssh`, Kind: 1 },
		{ Path: `${H}/uploads`, Kind: 1 },
		{ Path: "/tmp", Kind: 0 },
		{ Path: "/tmp/.st-ready", Kind: 1 },
		{ Path: "/tmp/tmux-1000", Kind: 1 },
		{ Path: "/tmp/tmux-1000/default", Kind: 1 },
	];
	return { changes, stats };
}

function input(patch: Partial<LayerInput> & { stats?: Map<string, PathStat> } = {}): LayerInput {
	const base = cleanBoot();
	const stats = patch.stats ?? base.stats;
	return {
		changes: patch.changes ?? base.changes,
		stat: async (p) => stats.get(p) ?? null,
		mounts: patch.mounts ?? [`${H}/workspace`, `${H}/uploads`],
		gitconfig: patch.gitconfig ?? (async () => null),
		identity: patch.identity === undefined ? ID : patch.identity,
		hasDotfiles: patch.hasDotfiles ?? false,
	};
}

describe("classifyLayer (§2.7.1 precondition 6)", () => {
	it("a clean entrypoint boot is lossless", async () => {
		expect(await classifyLayer(input())).toEqual({ blockers: [], reapplyGitIdentity: false });
	});

	it("Docker's --init mount point (/usr/sbin/docker-init, as a real daemon shows it) is allowed only as a file", async () => {
		const { changes, stats } = cleanBoot();
		changes.push(
			{ Path: "/usr", Kind: 0 },
			{ Path: "/usr/sbin", Kind: 0 },
			{ Path: "/usr/sbin/docker-init", Kind: 1 },
		);
		stats.set("/usr", { kind: "dir" });
		stats.set("/usr/sbin", { kind: "dir" });
		stats.set("/usr/sbin/docker-init", { kind: "file" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([]);
		stats.set("/usr/sbin/docker-init", { kind: "dir" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([
			{ code: "layer-system", count: 1 },
		]);
		// …and it does not open the rest of /usr.
		const more = [...changes, { Path: "/usr/sbin/other", Kind: 1 }];
		stats.set("/usr/sbin/docker-init", { kind: "file" });
		stats.set("/usr/sbin/other", { kind: "file" });
		expect((await classifyLayer(input({ changes: more, stats }))).blockers).toEqual([
			{ code: "layer-system", count: 1 },
		]);
	});

	it("what the bind mounts hold is never part of the layer", async () => {
		const { changes } = cleanBoot();
		changes.push({ Path: `${H}/workspace/anything`, Kind: 1 });
		expect((await classifyLayer(input({ changes }))).blockers).toEqual([]);
	});

	for (const link of ENTRYPOINT_SYMLINKS.keys()) {
		it(`wrong shape at ${link.replace(H, "~")}: a real dir, or a symlink elsewhere, blocks layer-home`, async () => {
			for (const wrong of [
				{ kind: "dir" } as PathStat,
				{ kind: "symlink", linkTarget: "/tmp/elsewhere" } as PathStat,
				{ kind: "symlink", linkTarget: `${ENTRYPOINT_SYMLINKS.get(link)}/` } as PathStat,
			]) {
				const { stats } = cleanBoot();
				stats.set(link, wrong);
				expect((await classifyLayer(input({ stats }))).blockers).toEqual([
					{ code: "layer-home", count: 1 },
				]);
			}
		});
	}

	it("~/.config, the sentinel, the relay log and the tmux dir must have their type", async () => {
		for (const [p, wrong] of [
			[`${H}/.config`, "file"],
			["/tmp/.st-ready", "dir"],
			["/tmp/tmux-1000", "file"],
			["/tmp/tmux-1000/default", "file"],
		] as const) {
			const { stats } = cleanBoot();
			stats.set(p, { kind: wrong });
			const code = p.startsWith("/tmp") ? "layer-tmp" : "layer-home";
			expect((await classifyLayer(input({ stats }))).blockers).toEqual([{ code, count: 1 }]);
		}
		const { changes, stats } = cleanBoot();
		changes.push({ Path: "/tmp/st-relay.log", Kind: 1 });
		stats.set("/tmp/st-relay.log", { kind: "file" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([]);
	});

	it("everything else blocks by category, with counts and never paths", async () => {
		const { changes, stats } = cleanBoot();
		changes.push(
			{ Path: `${H}/.bash_history`, Kind: 1 },
			{ Path: `${H}/.npm`, Kind: 1 },
			{ Path: `${H}/.npm/_cacache`, Kind: 1 },
			{ Path: "/tmp/build.log", Kind: 1 },
			{ Path: "/etc/apt/sources.list", Kind: 0 },
			{ Path: "/usr/local/bin/tool", Kind: 1 },
			{ Path: "/var/log/x", Kind: 2 },
		);
		const v = await classifyLayer(input({ changes, stats }));
		expect(v.blockers).toEqual([
			{ code: "layer-home", count: 3 },
			{ code: "layer-tmp", count: 1 },
			{ code: "layer-system", count: 3 },
		]);
		expect(JSON.stringify(v)).not.toContain("bash_history");
	});

	it("a changed parent dir is allowed only as an ancestor of something allowed", async () => {
		const { changes } = cleanBoot();
		changes.push({ Path: "/etc", Kind: 0 });
		const { stats } = cleanBoot();
		stats.set("/etc", { kind: "dir" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([
			{ code: "layer-system", count: 1 },
		]);
		// …but /etc is an ancestor of the control mount point of a 3.0d O.
		expect(
			(
				await classifyLayer(
					input({ changes, stats, mounts: [`${H}/workspace`, `${H}/uploads`, "/etc/st-control"] }),
				)
			).blockers,
		).toEqual([]);
	});

	it("deletions under ~/.npm-global count only once the symlink is verified exact", async () => {
		const { changes, stats } = cleanBoot();
		changes.push({ Path: `${H}/.npm-global/lib/node_modules`, Kind: 2 });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([]);
		stats.set(`${H}/.npm-global`, { kind: "dir" });
		expect((await classifyLayer(input({ changes, stats }))).blockers).toEqual([
			{ code: "layer-home", count: 2 },
		]);
	});

	describe("~/.gitconfig", () => {
		const withGitconfig = (buf: Buffer | "unreadable", identity: typeof ID | null = ID) => {
			const { changes } = cleanBoot();
			changes.push({ Path: `${H}/.gitconfig`, Kind: 1 });
			return input({ changes, gitconfig: async () => buf, identity });
		};
		it("exactly user.name and user.email equal to session_configs ⇒ allowed, gitIdentity re-run", async () => {
			expect(await classifyLayer(withGitconfig(GOOD_GITCONFIG))).toEqual({
				blockers: [],
				reapplyGitIdentity: true,
			});
		});
		for (const [label, text] of [
			[
				"an extra key",
				"[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n[core]\n\teditor = vim\n",
			],
			["another email", "[user]\n\tname = Ada Lovelace\n\temail = other@example.com\n"],
			["a comment", "# mine\n[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n"],
			[
				"an include",
				"[include]\n\tpath = x\n[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
			],
			[
				"a duplicated key",
				"[user]\n\tname = Ada Lovelace\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
			],
		] as const) {
			it(`${label} ⇒ layer-gitconfig-modified`, async () => {
				expect((await classifyLayer(withGitconfig(Buffer.from(text)))).blockers).toEqual([
					{ code: "layer-gitconfig-modified", count: 1 },
				]);
			});
		}
		it("no identity configured, oversized or unreadable ⇒ layer-gitconfig-modified", async () => {
			expect((await classifyLayer(withGitconfig(GOOD_GITCONFIG, null))).blockers).toEqual([
				{ code: "layer-gitconfig-modified", count: 1 },
			]);
			expect((await classifyLayer(withGitconfig("unreadable"))).blockers).toEqual([
				{ code: "layer-gitconfig-modified", count: 1 },
			]);
		});
		it("quoted values the way git writes them", () => {
			expect(parseGitconfig('[user]\n\tname = " Ada \\"L\\" "\n')?.get("user.name")).toEqual([
				' Ada "L" ',
			]);
			expect(parseGitconfig("[user]\n\tname = a # b\n")).toBeNull();
		});
	});

	it("dotfiles configured ⇒ layer-dotfiles, whatever the layer holds", async () => {
		expect((await classifyLayer(input({ hasDotfiles: true }))).blockers).toEqual([
			{ code: "layer-dotfiles", count: 1 },
		]);
	});

	describe("Claude Code 2.1.308's runtime artifacts under /tmp (CI evidence: cli-tmp-evidence.sh)", () => {
		const P = "/tmp/claude-1000/-home-developer-workspace";
		const U = "94568d46-b069-4373-98b1-b1db0b70716c";
		const AGENT = "a36654f4f7cfb543c";
		const TARGET = `${H}/workspace/.st/claude-state/projects/-home-developer-workspace/${U}/subagents/agent-${AGENT}.jsonl`;
		/** The four shapes the evidence showed, all at once: -p probes, a tab's task link, a stale socket. */
		function withCli(extra: Array<[string, PathStat | null]> = []) {
			const { changes, stats } = cleanBoot();
			const add = (p: string, st: PathStat | null) => {
				changes.push({ Path: p, Kind: 1 });
				if (st) stats.set(p, st);
			};
			add("/tmp/cc-socks", { kind: "dir" });
			add("/tmp/cc-socks/61.sock", { kind: "socket" });
			add("/tmp/claude-1000", { kind: "dir" });
			for (const probe of ["iOewuG", "p3nAut"]) {
				add(`/tmp/claude-1000/fswatch-probe-${probe}`, { kind: "dir" });
				add(`/tmp/claude-1000/fswatch-probe-${probe}/probe`, { kind: "file", size: 1 });
			}
			add(P, { kind: "dir" });
			add(`${P}/${U}`, { kind: "dir" });
			add(`${P}/${U}/tasks`, { kind: "dir" });
			add(`${P}/${U}/tasks/${AGENT}.output`, { kind: "symlink", linkTarget: TARGET });
			for (const [p, st] of extra) add(p, st);
			return input({ changes, stats });
		}
		const blockers = async (i: LayerInput) => (await classifyLayer(i)).blockers;

		it("the shapes seen on a real daemon don't block", async () => {
			expect(await blockers(withCli())).toEqual([]);
		});

		it("a slug of a cwd below the workspace, with its own transcript as target", async () => {
			const slug = "-home-developer-workspace-project";
			const d = `/tmp/claude-1000/${slug}`;
			expect(
				await blockers(
					withCli([
						[d, { kind: "dir" }],
						[`${d}/${U}`, { kind: "dir" }],
						[`${d}/${U}/tasks`, { kind: "dir" }],
						[
							`${d}/${U}/tasks/${AGENT}.output`,
							{
								kind: "symlink",
								linkTarget: `${H}/workspace/.st/claude-state/projects/${slug}/${U}/subagents/agent-${AGENT}.jsonl`,
							},
						],
					]),
				),
			).toEqual([]);
		});

		const T = `${P}/${U}/tasks`;
		const cases: Array<[string, Array<[string, PathStat | null]>]> = [
			[
				"a regular file in tasks/ (a background task's output)",
				[[`${T}/b1234567890abcdef.output`, { kind: "file", size: 40 }]],
			],
			[
				"a task link with the right name but another target",
				[[`${T}/a0123456789abcdef.output`, { kind: "symlink", linkTarget: "/etc/passwd" }]],
			],
			[
				"a task link pointing at another session's transcript",
				[
					[
						`${T}/a0123456789abcdef.output`,
						{
							kind: "symlink",
							linkTarget: `${H}/workspace/.st/claude-state/projects/-home-developer-workspace/00000000-0000-4000-8000-000000000000/subagents/agent-a0123456789abcdef.jsonl`,
						},
					],
				],
			],
			[
				"a task link pointing at another agent's transcript",
				[[`${T}/a0123456789abcdef.output`, { kind: "symlink", linkTarget: TARGET }]],
			],
			[
				"a task link with a relative target",
				[[`${T}/a0123456789abcdef.output`, { kind: "symlink", linkTarget: "../../x" }]],
			],
			[
				"a task link given unresolved, through ~/.claude (Docker reports it resolved)",
				[
					[
						`${T}/a0123456789abcdef.output`,
						{
							kind: "symlink",
							linkTarget: `${H}/.claude/projects/-home-developer-workspace/${U}/subagents/agent-a0123456789abcdef.jsonl`,
						},
					],
				],
			],
			["a task entry that is a directory", [[`${T}/a0123456789abcdef.output`, { kind: "dir" }]]],
			["a task name off the observed shape", [[`${T}/notes.txt`, { kind: "file", size: 3 }]]],
			[
				"a probe of 2 bytes",
				[
					["/tmp/claude-1000/fswatch-probe-abcdef", { kind: "dir" }],
					["/tmp/claude-1000/fswatch-probe-abcdef/probe", { kind: "file", size: 2 }],
				],
			],
			[
				"a probe that is a symlink",
				[
					["/tmp/claude-1000/fswatch-probe-abcdef", { kind: "dir" }],
					[
						"/tmp/claude-1000/fswatch-probe-abcdef/probe",
						{ kind: "symlink", linkTarget: "/etc/shadow" },
					],
				],
			],
			[
				"a probe without a known size",
				[
					["/tmp/claude-1000/fswatch-probe-abcdef", { kind: "dir" }],
					["/tmp/claude-1000/fswatch-probe-abcdef/probe", { kind: "file" }],
				],
			],
			[
				"another file in a probe dir",
				[["/tmp/claude-1000/fswatch-probe-iOewuG/data", { kind: "file", size: 1 }]],
			],
			[
				"a probe dir name off the observed shape",
				[["/tmp/claude-1000/fswatch-probe-toolong1", { kind: "dir" }]],
			],
			[
				"a file directly in /tmp/claude-1000",
				[["/tmp/claude-1000/notes", { kind: "file", size: 1 }]],
			],
			["a file in a project dir", [[`${P}/notes`, { kind: "file", size: 1 }]]],
			["a file in a session dir", [[`${P}/${U}/notes`, { kind: "file", size: 1 }]]],
			["a deeper dir under tasks/", [[`${T}/sub`, { kind: "dir" }]]],
			["a slug outside the workspace", [["/tmp/claude-1000/-tmp", { kind: "dir" }]]],
			["a session dir that is not a uuid", [[`${P}/scratchpad`, { kind: "dir" }]]],
			["another uid's dir", [["/tmp/claude-0", { kind: "dir" }]]],
			["a regular file in cc-socks", [["/tmp/cc-socks/62.sock", { kind: "file", size: 0 }]]],
			["a socket name off the observed shape", [["/tmp/cc-socks/x.sock", { kind: "socket" }]]],
			[
				"a symlink as /tmp/claude-1000's sibling",
				[["/tmp/cc-socks2", { kind: "symlink", linkTarget: "/home/developer/workspace" }]],
			],
			["an entry that vanished (no stat)", [[`${T}/a0123456789abcdee.output`, null]]],
		];
		for (const [label, extra] of cases) {
			it(`${label} ⇒ layer-tmp`, async () => {
				expect(await blockers(withCli(extra))).toEqual([{ code: "layer-tmp", count: 1 }]);
			});
		}

		it("the allowed paths with the wrong type block too", async () => {
			const { changes, stats } = cleanBoot();
			for (const [p, st] of [
				["/tmp/cc-socks", { kind: "symlink", linkTarget: "/home/developer/workspace" }],
				["/tmp/claude-1000", { kind: "file", size: 1 }],
				[P, { kind: "symlink", linkTarget: "/" }],
				[`${P}/${U}/tasks`, { kind: "file", size: 0 }],
			] as Array<[string, PathStat]>) {
				changes.push({ Path: p, Kind: 1 });
				stats.set(p, st);
			}
			expect(await blockers(input({ changes, stats }))).toEqual([{ code: "layer-tmp", count: 4 }]);
		});

		it("deleted or merely changed artifacts are not covered: they block", async () => {
			const i = withCli();
			const deleted = {
				...i,
				changes: [...i.changes, { Path: "/tmp/claude-1000/fswatch-probe-zzzzzz", Kind: 2 }],
			};
			expect(await blockers(deleted)).toEqual([{ code: "layer-tmp", count: 1 }]);
			const { changes, stats } = cleanBoot();
			changes.push({ Path: "/tmp/cc-socks", Kind: 0 });
			stats.set("/tmp/cc-socks", { kind: "dir" });
			expect(await blockers(input({ changes, stats }))).toEqual([{ code: "layer-tmp", count: 1 }]);
		});

		it("nothing else is widened: HOME, system and packages still block", async () => {
			expect(
				await blockers(
					withCli([
						[`${H}/.cache`, { kind: "dir" }],
						["/usr/bin/bc", { kind: "file", size: 90_000 }],
					]),
				),
			).toEqual([
				{ code: "layer-home", count: 1 },
				{ code: "layer-system", count: 1 },
			]);
		});
	});
});
