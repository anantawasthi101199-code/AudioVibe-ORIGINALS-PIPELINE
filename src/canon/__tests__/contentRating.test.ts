import { loadPersona } from '../load';

describe('content rating', () => {
  it('Crime Files is mature, other channels default to general', () => {
    expect(loadPersona('crime-files').contentRating).toBe('mature');
    expect(loadPersona('eureka-tales').contentRating).toBe('general');
  });
});
