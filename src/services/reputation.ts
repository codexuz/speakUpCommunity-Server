import prisma from '../prisma';

/**
 * Get or create UserReputation for a user
 */
export async function getOrCreateReputation(userId: string) {
  return prisma.userReputation.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

/**
 * Record a helpful vote on a review
 */
export async function addHelpfulVote(reviewerId: string) {
  const rep = await getOrCreateReputation(reviewerId);

  const newHelpful = rep.helpfulVotes + 1;
  const newMentorLevel = calculateMentorLevel(newHelpful, rep.reviewsGiven);

  await prisma.userReputation.update({
    where: { userId: reviewerId },
    data: {
      helpfulVotes: newHelpful,
      mentorLevel: newMentorLevel,
      badges: computeBadges(newHelpful, rep.reviewsGiven, newMentorLevel),
    },
  });
}

/**
 * Increment reviews given count
 */
export async function incrementReviewsGiven(reviewerId: string) {
  const rep = await getOrCreateReputation(reviewerId);

  const newReviewsGiven = rep.reviewsGiven + 1;
  const newMentorLevel = calculateMentorLevel(rep.helpfulVotes, newReviewsGiven);

  await prisma.userReputation.update({
    where: { userId: reviewerId },
    data: {
      reviewsGiven: newReviewsGiven,
      mentorLevel: newMentorLevel,
      badges: computeBadges(rep.helpfulVotes, newReviewsGiven, newMentorLevel),
    },
  });
}

/**
 * Update clarity score (rolling average from user ratings of reviews)
 */
export async function updateClarityScore(reviewerId: string, rating: number) {
  const rep = await getOrCreateReputation(reviewerId);
  const n = rep.reviewsGiven || 1;
  const newClarity = (rep.clarityScore * (n - 1) + rating) / n;

  await prisma.userReputation.update({
    where: { userId: reviewerId },
    data: { clarityScore: Math.round(newClarity * 10) / 10 },
  });
}

function calculateMentorLevel(helpfulVotes: number, reviewsGiven: number): number {
  if (helpfulVotes >= 100 && reviewsGiven >= 100) return 3; // Expert
  if (helpfulVotes >= 30 && reviewsGiven >= 50) return 2;   // Mentor
  if (helpfulVotes >= 10 && reviewsGiven >= 10) return 1;   // Helper
  return 0;
}

function computeBadges(helpfulVotes: number, reviewsGiven: number, mentorLevel: number): string[] {
  const badges: string[] = [];

  if (helpfulVotes >= 10) badges.push('helpful_reviewer');
  if (helpfulVotes >= 50) badges.push('super_helpful');
  if (reviewsGiven >= 50) badges.push('dedicated_reviewer');
  if (reviewsGiven >= 100) badges.push('review_master');
  if (mentorLevel >= 2) badges.push('fluency_mentor');
  if (mentorLevel >= 3) badges.push('grammar_guru');

  return badges;
}
