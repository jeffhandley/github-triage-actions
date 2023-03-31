"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.download = void 0;
const axios_1 = require("axios");
const fs_1 = require("fs");
const path_1 = require("path");
const cockatiel_1 = require("cockatiel");
async function loadData(owner, repo, token, endCursor) {
    const response = await axios_1.default.post('https://api.github.com/graphql', JSON.stringify({
        query: `{
			repository(name: "${repo}", owner: "${owner}") {
				issues(first: 100 ${endCursor ? `after: "${endCursor}"` : ''}) {
					pageInfo {
						endCursor
						hasNextPage
					}
					nodes {
						body
						bodyText
						title
						number
						createdAt
						userContentEdits(first: 100) {
							nodes {
								editedAt
								diff
							}
						}
						assignees(first: 100) {
							nodes {
								login
							}
						}
						labels(first: 100) {
							nodes {
								name
							}
						}
						timelineItems(itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT, UNLABELED_EVENT, CLOSED_EVENT, ISSUE_COMMENT], first: 250) {
							nodes {
								__typename
								... on UnlabeledEvent {
									createdAt
									label { name }
								}
								... on LabeledEvent {
									createdAt
									label { name }
									actor { login }
								}
								... on RenamedTitleEvent {
									createdAt
									currentTitle
									previousTitle
								}
								... on ClosedEvent {
									__typename
								}
								... on IssueComment {
									author { login }
									bodyText
								}
							}
						}
					}
				}
			}
			rateLimit {
				cost
				remaining
			}
		}`,
    }), {
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: 'bearer ' + token,
        },
    });
    return response.data.data;
}
// Combine these! Create a policy that retries 3 times, calling through the circuit breaker
const retryWithBreaker = (0, cockatiel_1.wrap)(
// Create a retry policy that'll try whatever function we execute 3
// times with a randomized exponential backoff.
(0, cockatiel_1.retry)(cockatiel_1.handleAll, { maxAttempts: 10, backoff: new cockatiel_1.ExponentialBackoff() }), 
// Create a circuit breaker that'll stop calling the executed function for 60
// seconds if it fails 5 times in a row. This can give time for e.g. a database
// to recover without getting tons of traffic.
(0, cockatiel_1.circuitBreaker)(cockatiel_1.handleAll, {
    halfOpenAfter: 60 * 1000,
    breaker: new cockatiel_1.ConsecutiveBreaker(5),
}));
const download = async (token, repo, endCursor) => {
    const response = await retryWithBreaker.execute(() => loadData(repo.owner, repo.repo, token, endCursor));
    const issues = response.repository.issues.nodes.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        bodyText: issue.bodyText,
        createdAt: +new Date(issue.createdAt),
        labels: issue.labels.nodes.map((label) => label.name),
        assignees: issue.assignees.nodes.map((assignee) => assignee.login),
        labelEvents: extractLabelEvents(issue),
        commentEvents: extractCommentEvents(issue),
        closedWithCode: !!issue.timelineItems.nodes.find((event) => {
            var _a, _b;
            return event.__typename === 'ClosedEvent' &&
                (((_a = event.closer) === null || _a === void 0 ? void 0 : _a.__typename) === 'PullRequest' || ((_b = event.closer) === null || _b === void 0 ? void 0 : _b.__typename) === 'Commit');
        }),
    }));
    (0, fs_1.writeFileSync)((0, path_1.join)(__dirname, 'issues.json'), issues.map((issue) => JSON.stringify(issue)).join('\n') + '\n', {
        flag: 'a',
    });
    const pageInfo = response.repository.issues.pageInfo;
    const rateInfo = response.rateLimit;
    console.log({
        lastIssue: issues[issues.length - 1].number,
        quota: rateInfo.remaining,
        endCursor: pageInfo.endCursor,
    });
    endCursor = pageInfo.endCursor;
    if (pageInfo.hasNextPage) {
        return new Promise((resolve) => {
            // to avoid rate limit
            // https://docs.github.com/en/graphql/overview/resource-limitations#rate-limit
            setTimeout(async () => {
                await (0, exports.download)(token, repo, endCursor);
                resolve();
            }, 600);
        });
    }
};
exports.download = download;
const extractLabelEvents = (_issue) => {
    var _a, _b, _c, _d;
    const issue = _issue;
    const events = [];
    events.push(...issue.userContentEdits.nodes.map((node) => ({ timestamp: +new Date(node.editedAt), type: 'bodyEdited', new: node.diff })));
    events.push(...issue.timelineItems.nodes
        .filter((node) => node.__typename === 'LabeledEvent')
        .map((node) => ({ ...node, issue }))
        .map((node) => {
        var _a, _b;
        return ({
            timestamp: +new Date(node.createdAt),
            type: 'labeled',
            label: node.label.name,
            actor: (_b = (_a = node.actor) === null || _a === void 0 ? void 0 : _a.login) !== null && _b !== void 0 ? _b : 'ghost',
        });
    }));
    events.push(...issue.timelineItems.nodes
        .filter((node) => node.__typename === 'UnlabeledEvent')
        .map((node) => ({
        timestamp: +new Date(node.createdAt),
        type: 'unlabeled',
        label: node.label.name,
    })));
    events.push(...issue.timelineItems.nodes
        .filter((node) => node.__typename === 'RenamedTitleEvent')
        .map((node) => ({
        timestamp: +new Date(node.createdAt),
        type: 'titleEdited',
        new: node.currentTitle,
        old: node.previousTitle,
    })));
    events.sort(({ timestamp: a }, { timestamp: b }) => a - b);
    let currentTitle = (_b = (_a = events.find((event) => event.type === 'titleEdited')) === null || _a === void 0 ? void 0 : _a.old) !== null && _b !== void 0 ? _b : issue.title;
    let currentBody = (_d = (_c = events.find((event) => event.type === 'bodyEdited')) === null || _c === void 0 ? void 0 : _c.new) !== null && _d !== void 0 ? _d : issue.body;
    const labelEvents = [];
    for (const event of events) {
        if (event.type === 'labeled') {
            labelEvents.push({
                type: 'added',
                actor: event.actor,
                label: event.label,
                body: currentBody,
                title: currentTitle,
            });
        }
        else if (event.type === 'bodyEdited') {
            currentBody = event.new;
        }
        else if (event.type === 'titleEdited') {
            currentTitle = event.new;
        }
        else if (event.type === 'unlabeled') {
            labelEvents.push({ type: 'removed', label: event.label });
        }
    }
    return labelEvents;
};
function isCommentEvent(node) {
    return node.__typename === 'IssueComment';
}
const extractCommentEvents = (issue) => {
    const result = [];
    for (const node of issue.timelineItems.nodes) {
        if (isCommentEvent(node)) {
            result.push({
                author: node.author.login,
                bodyText: node.bodyText
            });
        }
    }
    return result;
};
//# sourceMappingURL=download.js.map