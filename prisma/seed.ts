import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting seeding...');

  // 1. Load data
  const dataPath = path.join(__dirname, '../ielts-questions.json');
  const rawData = fs.readFileSync(dataPath, 'utf8');
  const allQuestions = JSON.parse(rawData);

  // 2. Group by part and topic
  const part1ByTopic: Record<string, any[]> = {};
  const part2Questions: any[] = [];
  const part3ByTopic: Record<string, any[]> = {};

  allQuestions.forEach((q: any) => {
    const part = q.part;
    const topic = q.topic || 'General';

    if (part === 1) {
      if (!part1ByTopic[topic]) part1ByTopic[topic] = [];
      part1ByTopic[topic].push(q);
    } else if (part === 2) {
      part2Questions.push(q);
    } else if (part === 3) {
      if (!part3ByTopic[topic]) part3ByTopic[topic] = [];
      part3ByTopic[topic].push(q);
    }
  });

  const part1TopicKeys = Object.keys(part1ByTopic);
  const part3TopicKeys = Object.keys(part3ByTopic);

  console.log(`Found ${part1TopicKeys.length} topics for Part 1`);
  console.log(`Found ${part2Questions.length} questions for Part 2`);
  console.log(`Found ${part3TopicKeys.length} topics for Part 3`);

  // 3. Determine number of tests to generate
  // We'll generate as many as there are Part 1 topics or Part 2 questions
  const numTests = Math.max(part1TopicKeys.length, part2Questions.length, part3TopicKeys.length);

  for (let i = 0; i < numTests; i++) {
    const testTitle = `Test ${i + 2}`;

    // Create Test
    const test = await prisma.test.create({
      data: {
        title: testTitle,
        description: `IELTS Speaking Practice Test - ${testTitle}`,
        testType: 'ielts',
      },
    });

    // Add Part 1 Questions (Topic based)
    const p1Topic = part1TopicKeys[i % part1TopicKeys.length];
    const p1Qs = part1ByTopic[p1Topic];
    for (const q of p1Qs) {
      await prisma.question.create({
        data: {
          testId: test.id,
          qText: q.q_text,
          part: 'Part 1',
          speakingTimer: 60,
          prepTimer: 5,
        },
      });
    }

    // Add Part 2 Question
    const p2Q = part2Questions[i % part2Questions.length];
    if (p2Q) {
      await prisma.question.create({
        data: {
          testId: test.id,
          qText: p2Q.q_text,
          part: 'Part 2',
          speakingTimer: 120,
          prepTimer: 60,
        },
      });
    }

    // Add Part 3 Questions (Topic based)
    const p3Topic = part3TopicKeys[i % part3TopicKeys.length];
    const p3Qs = part3ByTopic[p3Topic];
    if (p3Qs) {
      for (const q of p3Qs) {
        await prisma.question.create({
          data: {
            testId: test.id,
            qText: q.q_text,
            part: 'Part 3',
            speakingTimer: 60,
            prepTimer: 5,
          },
        });
      }
    }

    console.log(`Created ${testTitle} with Part 1 Topic: "${p1Topic}" and Part 3 Topic: "${p3Topic}"`);
  }

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
