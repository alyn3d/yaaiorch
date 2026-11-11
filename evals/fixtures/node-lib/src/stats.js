import { sum } from "./array.js";

/** Arithmetic mean; 0 for an empty list. */
export function mean(nums) {
  if (nums.length === 0) return 0;
  return sum(nums) / nums.length;
}

/** Largest minus smallest; 0 for an empty list. */
export function range(nums) {
  if (nums.length === 0) return 0;
  return Math.max(...nums) - Math.min(...nums);
}
