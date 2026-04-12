import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed a sample test
  const test = await prisma.test.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      title: 'IELTS Speaking Mock Test 1',
      description: 'A full mock speaking test covering Parts 1, 2, and 3',
    },
  });

  const questions = [
    { id: 1, testId: 1, qText: 'Tell me about your favorite TV program?', part: '1.1', image: null, speakingTimer: 30, prepTimer: 5 },
    { id: 2, testId: 1, qText: 'Do you like watching TV alone or with other people?', part: '1.1', image: null, speakingTimer: 30, prepTimer: 5 },
    { id: 3, testId: 1, qText: 'Do you often watch TV these days?', part: '1.1', image: null, speakingTimer: 30, prepTimer: 5 },
    { id: 4, testId: 1, qText: 'Describe these pictures.', part: '1.2', image: 'https://i.ibb.co/HfdSYrNJ/test1.png', speakingTimer: 45, prepTimer: 10 },
    { id: 5, testId: 1, qText: 'What are the advantages of running over playing chess?', part: '1.2', image: null, speakingTimer: 30, prepTimer: 5 },
    { id: 6, testId: 1, qText: 'Which activity is more popular in your country? Running or chess?', part: '1.2', image: null, speakingTimer: 30, prepTimer: 5 },
    { id: 7, testId: 1, qText: 'Tell me about the item you dreamed of owning. Did you get it? Is luxury items old people want to have different from the ones young people want to have?', part: '2', image: null, speakingTimer: 120, prepTimer: 60 },
    { id: 8, testId: 1, qText: 'Governments should ban single-use plastics.', part: '3', image: 'https://i.ibb.co/FLFDVrXd/test1-3.png', speakingTimer: 120, prepTimer: 60 },
  ];

  for (const q of questions) {
    await prisma.question.upsert({
      where: { id: q.id },
      update: {},
      create: q,
    });
  }

  console.log('Seed completed:', test.title, `with ${questions.length} questions`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
