import assert from "node:assert/strict";
import { voteReviewFlags } from "../../../lib/arena/voteReview";

const ordinary = { votes: 30, choiceA: 14, choiceB: 14, bothBad: 2, fastVotes: 0, repeatVotes: 2, sharedPairs: 40, agreement: 0.75 };
assert.deepEqual(voteReviewFlags(ordinary), []);
assert.deepEqual(voteReviewFlags({ ...ordinary, fastVotes: 15 }), ["Rapid voting"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, choiceA: 26, choiceB: 2 }), ["One-sided voting"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, agreement: 0.59 }), ["Low agreement"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, agreement: 0.6 }), []);
assert.deepEqual(voteReviewFlags({ ...ordinary, sharedPairs: 29, agreement: 0.2 }), []);
assert.deepEqual(voteReviewFlags({ ...ordinary, sharedPairs: 0, agreement: null }), []);
assert.deepEqual(voteReviewFlags({ ...ordinary, repeatVotes: 15 }), ["Repeated matchups"]);
assert.deepEqual(voteReviewFlags({ votes: 3, choiceA: 0, choiceB: 3, bothBad: 0, fastVotes: 2, repeatVotes: 2, sharedPairs: 3, agreement: 0 }), []);
assert.deepEqual(voteReviewFlags({ votes: 21, choiceA: 6, choiceB: 5, bothBad: 10, fastVotes: 0, repeatVotes: 2, sharedPairs: 30, agreement: 0.5 }), ["Low agreement", "Frequent rejections"]);
console.log("vote review signal checks passed");
