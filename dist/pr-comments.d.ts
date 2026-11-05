import type { PrComment } from "./github.js";
export interface PrCommentPolicy {
    mentions: string[];
}
export declare function isActionablePrComment(comment: PrComment, policy: PrCommentPolicy): boolean;
export declare function actionablePrComments(comments: PrComment[], handledAt: string | null | undefined, policy: PrCommentPolicy): PrComment[];
